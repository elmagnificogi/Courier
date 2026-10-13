import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { config } from "../config";
import { logger } from "../logger";
import { AgentProgressEvent } from "../types";
import { CommandRouter } from "./CommandRouter";
import { notificationHub } from "./NotificationHub";
import { HttpResult } from "./HttpResult";
import { TextSecurityGuard } from "../security/TextSecurityGuard";
import { isQqFileAttachment, isQqImageAttachment, qqAttachmentFileName } from "./qqAttachments";
import { ed25519PrivateKeyDer, MessageDeduper, splitMessage } from "./weixinCrypto";

/** QQ C2C stream_messages hard limit for a single content_raw. */
const QQ_STREAM_MAX_CHARS = 4000;
/** Match AstrBot: throttle mid-stream replace updates (~1s). */
const QQ_STREAM_THROTTLE_MS = 1000;
/**
 * If Cursor pauses mid-turn (tools / thinking), seal the open stream segment so PC QQ
 * does not keep an input_state=1 bubble that shows as 「不支持的消息类型」.
 */
const QQ_STREAM_IDLE_SEAL_MS = 12_000;

interface C2cStreamState {
  streamMsgId: string | null;
  index: number;
  /** Exact content_raw last accepted by QQ (immutable prefix for replace mode). */
  sent: string;
  msgSeq: number | null;
  failed: boolean;
  /** True after input_state=10 was accepted (or stream never started). */
  finished: boolean;
  lastPushAt: number;
  /** Passive-reply msg_id / event_id anchor from the inbound user message. */
  replyMsgId: string;
}

interface TokenCache {
  value: string;
  expiresAt: number;
}

interface QQAttachment {
  url?: string;
  filename?: string;
  content_type?: string;
  width?: number;
  height?: number;
  size?: number;
}

interface QQWebhookPayload {
  op?: number;
  s?: number;
  t?: string;
  id?: string;
  d?: {
    plain_token?: string;
    event_ts?: string;
    heartbeat_interval?: number;
    session_id?: string;
    id?: string;
    content?: string;
    group_openid?: string;
    attachments?: QQAttachment[];
    author?: {
      user_openid?: string;
      member_openid?: string;
      id?: string;
    };
  };
}

const GROUP_AND_C2C_EVENT = 1 << 25;

export class QQService {
  private readonly router = new CommandRouter();
  private readonly deduper = new MessageDeduper();
  private readonly seqByMsgId = new Map<string, number>();
  /** Serialize private Cursor jobs so overlapping QQ prompts do not race one Composer/stream. */
  private readonly privateRelayQueue = new Map<string, Promise<void>>();
  private readonly privateQueueDepth = new Map<string, number>();
  private token: TokenCache | null = null;
  private registered = false;
  private ws: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private lastSeq: number | null = null;
  private sessionId: string | null = null;
  private reconnectAttempt = 0;
  private connecting = false;

  enabled(): boolean {
    return config.qq.enabled && this.hasRequiredConfig();
  }

  private get eventMode(): "websocket" | "webhook" | "both" {
    return config.qq.eventMode;
  }

  start(): void {
    if (!config.qq.enabled) {
      logger.info("QQ bot adapter disabled");
      return;
    }
    if (!this.hasRequiredConfig()) {
      logger.warn("QQ adapter enabled but app id / secret is incomplete");
      return;
    }
    this.registerNotifier();
    if (this.eventMode === "websocket" || this.eventMode === "both") {
      void this.connectGateway();
      logger.info("QQ bot adapter ready (WebSocket gateway, no public URL required)");
    }
    if (this.eventMode === "webhook" || this.eventMode === "both") {
      logger.info("QQ bot adapter ready (callback: POST /platform/qq/events)");
    }
  }

  async handleEvents(rawBody: string, headers: Record<string, string | undefined>): Promise<HttpResult> {
    if (!this.enabled()) {
      return { status: 404, body: { ok: false, error: "QQ adapter disabled" } };
    }

    let payload: QQWebhookPayload;
    try {
      payload = JSON.parse(rawBody) as QQWebhookPayload;
    } catch {
      return { status: 400, body: { ok: false, error: "invalid json" } };
    }

    if (payload.op === 13) {
      const plainToken = payload.d?.plain_token ?? "";
      const eventTs = payload.d?.event_ts ?? "";
      if (!plainToken || !eventTs) {
        return { status: 400, body: { ok: false, error: "invalid validation payload" } };
      }
      return {
        status: 200,
        body: {
          plain_token: plainToken,
          signature: this.sign(`${eventTs}${plainToken}`)
        }
      };
    }

    if (!this.verifyRequest(rawBody, headers)) {
      return { status: 401, body: { ok: false, error: "invalid qq signature" } };
    }

    if (payload.t === "C2C_MESSAGE_CREATE" || payload.t === "GROUP_AT_MESSAGE_CREATE" || payload.t === "GROUP_MESSAGE_CREATE") {
      this.dispatchEvent(payload);
      return { status: 200, body: { ok: true } };
    }

    return { status: 200, body: { ok: true, ignored: true } };
  }

  private dispatchEvent(payload: QQWebhookPayload): void {
    if (payload.t === "C2C_MESSAGE_CREATE") {
      const openId = payload.d?.author?.user_openid || payload.d?.author?.id || "";
      const msgId = payload.d?.id ?? "";
      const text = (payload.d?.content ?? "").trim();
      const attachments = payload.d?.attachments ?? [];
      logger.info(
        { userOpenId: openId, msgId, attachmentCount: attachments.length },
        "QQ C2C message received"
      );
      if (this.deduper.seenBefore(`qq:c2c:${msgId || openId + text}`)) {
        return;
      }
      void this.processPrivate(openId, msgId, text, attachments).catch((error) => {
        logger.warn({ error, openId }, "QQ C2C handling failed");
      });
      return;
    }

    if (payload.t === "GROUP_AT_MESSAGE_CREATE" || payload.t === "GROUP_MESSAGE_CREATE") {
      const groupOpenId = payload.d?.group_openid ?? "";
      const memberOpenId = payload.d?.author?.member_openid || payload.d?.author?.id || "";
      const msgId = payload.d?.id ?? "";
      const text = this.stripMention((payload.d?.content ?? "").trim());
      const attachments = payload.d?.attachments ?? [];
      logger.info(
        { groupOpenId, memberOpenId, msgId, attachmentCount: attachments.length },
        "QQ group message received"
      );
      if (this.deduper.seenBefore(`qq:group:${msgId || groupOpenId + text}`)) {
        return;
      }
      void this.processGroup(groupOpenId, memberOpenId, msgId, text, attachments).catch((error) => {
        logger.warn({ error, groupOpenId }, "QQ group handling failed");
      });
    }
  }

  async notifyAllowedUsers(text: string): Promise<void> {
    if (!this.enabled()) {
      return;
    }
    for (const openId of config.qq.allowedOpenIds) {
      try {
        await this.sendPrivate(openId, text);
      } catch (error) {
        logger.warn({ error, openId }, "QQ notify failed");
      }
    }
  }

  private async processPrivate(
    openId: string,
    msgId: string,
    text: string,
    attachments: QQAttachment[] = []
  ): Promise<void> {
    if (!openId) {
      return;
    }
    if (this.isIdentityCommand(text)) {
      await this.sendPrivate(openId, this.privateIdentityText(openId), msgId);
      return;
    }
    if (config.qq.allowedOpenIds.length > 0 && !config.qq.allowedOpenIds.includes(openId)) {
      await this.sendPrivate(
        openId,
        `未授权用户。\n你的 user_openid：\n${openId}\n请写入 QQ_ALLOWED_OPEN_IDS 后重启 Courier。`,
        msgId
      );
      return;
    }
    const images = attachments.filter((item) => isQqImageAttachment(item));
    const files = attachments.filter((item) => isQqFileAttachment(item));
    if (images.length > 0 || files.length > 0) {
      await this.enqueuePrivateJob(openId, msgId, () =>
        this.handleIncomingAttachments(openId, msgId, text, images, files, "private")
      );
      return;
    }
    if (!text) {
      await this.sendPrivate(openId, "请发送文本命令，例如 /help。图片和文件可以直接发。", msgId);
      return;
    }
    try {
      if (this.isRelayText(text)) {
        await this.enqueuePrivateJob(openId, msgId, () => this.relayPrivateStream(openId, msgId, text, `qq:${openId}`));
      } else {
        await this.relayAndReply(openId, msgId, text, "private");
      }
    } catch (error) {
      logger.warn({ error, openId }, "QQ command failed");
      await this.sendPrivate(openId, "请求失败，请查看 Courier 日志。", msgId);
    }
  }

  private async processGroup(
    groupOpenId: string,
    memberOpenId: string,
    msgId: string,
    text: string,
    attachments: QQAttachment[] = []
  ): Promise<void> {
    if (!groupOpenId) {
      return;
    }
    if (this.isIdentityCommand(text)) {
      await this.sendGroup(groupOpenId, this.groupIdentityText(groupOpenId, memberOpenId), msgId);
      return;
    }
    if (config.qq.allowedGroupOpenIds.length > 0 && !config.qq.allowedGroupOpenIds.includes(groupOpenId)) {
      return;
    }
    if (config.qq.allowedOpenIds.length > 0 && memberOpenId && !config.qq.allowedOpenIds.includes(memberOpenId)) {
      return;
    }
    const images = attachments.filter((item) => isQqImageAttachment(item));
    const files = attachments.filter((item) => isQqFileAttachment(item));
    if (images.length > 0 || files.length > 0) {
      await this.handleIncomingAttachments(groupOpenId, msgId, text, images, files, "group", memberOpenId);
      return;
    }
    if (!text) {
      await this.sendGroup(groupOpenId, "请发送文本命令，例如 /help。图片和文件可以直接发。", msgId);
      return;
    }
    try {
      await this.relayAndReply(groupOpenId, msgId, text, "group", memberOpenId);
    } catch (error) {
      logger.warn({ error, groupOpenId }, "QQ group command failed");
      await this.sendGroup(groupOpenId, "请求失败，请查看 Courier 日志。", msgId);
    }
  }

  private async handleIncomingAttachments(
    targetId: string,
    msgId: string,
    text: string,
    images: QQAttachment[],
    files: QQAttachment[],
    kind: "private" | "group",
    memberOpenId?: string
  ): Promise<void> {
    const channelId = kind === "private" ? `qq:${targetId}` : `qq-group:${targetId}:${memberOpenId ?? ""}`;
    const send = (content: string) =>
      kind === "private"
        ? this.sendPrivate(targetId, content, msgId)
        : this.sendGroup(targetId, content, msgId);
    const items = [
      ...images.map((attachment) => ({ attachment, mediaKind: "photo" as const })),
      ...files.map((attachment) => ({ attachment, mediaKind: "document" as const }))
    ];
    if (items.length === 0) {
      return;
    }
    try {
      let reply = "";
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        if (!item) {
          continue;
        }
        const downloaded = await this.downloadAttachment(item.attachment, item.mediaKind);
        const isLast = index === items.length - 1;
        const prompt = isLast ? text.trim() : "";
        const attachOptions: {
          fileName: string;
          mimeType?: string;
          prompt?: string;
          onProgress?: (event: AgentProgressEvent) => Promise<void>;
        } = { fileName: downloaded.fileName };
        if (downloaded.mimeType) {
          attachOptions.mimeType = downloaded.mimeType;
        }
        const stream: C2cStreamState | null =
          isLast && prompt && this.isRelayText(prompt) && kind === "private"
            ? {
                streamMsgId: null,
                index: 0,
                sent: "",
                msgSeq: null,
                failed: false,
                finished: false,
                lastPushAt: 0,
                replyMsgId: msgId
              }
            : null;
        if (prompt && this.isRelayText(prompt)) {
          attachOptions.prompt = prompt;
          if (stream) {
            await send(`附件已收到，正在转发给 ${this.router.ideLabel(channelId)}…`);
            attachOptions.onProgress = async (event) => {
              const snapshot = event.content?.trim();
              if (snapshot) {
                await this.pushC2cStream(targetId, msgId, stream, snapshot, false);
              }
            };
          }
        }
        try {
          reply = await this.router.attachMedia(channelId, downloaded.path, item.mediaKind, attachOptions);
          if (stream) {
            const finalText = (reply || stream.sent || "").trim();
            if (!finalText) {
              await this.finishC2cStream(targetId, msgId, stream);
              await send("附件已送达，但还没有捕获到完整回复。");
              return;
            }
            const closed = await this.pushC2cStream(targetId, msgId, stream, finalText, true);
            if (!closed) {
              await this.finishC2cStream(targetId, msgId, stream);
              await this.sendPrivate(targetId, finalText, msgId, false);
            }
            return;
          }
        } finally {
          if (stream && stream.streamMsgId && !stream.finished) {
            await this.finishC2cStream(targetId, msgId, stream);
          }
        }
      }
      await send(reply);
    } catch (error) {
      logger.warn({ error, targetId }, "QQ attachment attach failed");
      await send("图片或文件下载失败，请再发一次，或把文件存到电脑后发本地路径。");
    }
  }

  private normalizeAttachmentUrl(url: string): string {
    const trimmed = url.trim();
    if (!trimmed) {
      return "";
    }
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
      return trimmed;
    }
    return `https://${trimmed.replace(/^\/+/, "")}`;
  }

  private async downloadAttachment(
    attachment: QQAttachment,
    mediaKind: "photo" | "document" = "photo"
  ): Promise<{ path: string; fileName: string; mimeType?: string }> {
    const url = this.normalizeAttachmentUrl(attachment.url ?? "");
    if (!url) {
      throw new Error("QQ attachment url missing");
    }
    const token = await this.getAccessToken();
    let response = await fetch(url, {
      headers: {
        authorization: `QQBot ${token}`,
        "x-union-appid": config.qq.appId
      }
    });
    if (!response.ok) {
      response = await fetch(url);
    }
    if (!response.ok) {
      throw new Error(`QQ attachment download failed: ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const downloadDir = join(process.cwd(), "tmp", mediaKind === "document" ? "qq-files" : "qq-images");
    mkdirSync(downloadDir, { recursive: true });
    const fileName = qqAttachmentFileName(attachment, mediaKind);
    const filePath = join(downloadDir, `${Date.now()}-${fileName}`);
    await writeFile(filePath, buffer);
    logger.info({ filePath, bytes: buffer.length, fileName }, "QQ attachment downloaded");
    const downloaded: { path: string; fileName: string; mimeType?: string } = { path: filePath, fileName };
    if (attachment.content_type) {
      downloaded.mimeType = attachment.content_type;
    }
    return downloaded;
  }

  private isRelayText(text: string): boolean {
    const value = text.trim();
    if (!value.startsWith("/")) {
      return true;
    }
    return /^\/(resume|choose)(\s|$)/i.test(value);
  }

  private formatProgress(event: AgentProgressEvent): string {
    return event.text;
  }

  private async enqueuePrivateJob(openId: string, msgId: string, job: () => Promise<void>): Promise<void> {
    const depth = (this.privateQueueDepth.get(openId) ?? 0) + 1;
    this.privateQueueDepth.set(openId, depth);
    if (depth > 1) {
      await this.sendPrivate(
        openId,
        `已收到，前面还有 ${depth - 1} 个任务在跑，会按顺序单独回复，不会混在一起。`,
        msgId
      );
    }
    const previous = this.privateRelayQueue.get(openId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => {
      try {
        await job();
      } finally {
        const left = Math.max(0, (this.privateQueueDepth.get(openId) ?? 1) - 1);
        if (left === 0) {
          this.privateQueueDepth.delete(openId);
        } else {
          this.privateQueueDepth.set(openId, left);
        }
      }
    });
    this.privateRelayQueue.set(
      openId,
      run.finally(() => {
        if (this.privateRelayQueue.get(openId) === run) {
          this.privateRelayQueue.delete(openId);
        }
      })
    );
    await run;
  }

  private async relayPrivateStream(
    targetId: string,
    msgId: string,
    text: string,
    channelId: string
  ): Promise<void> {
    await this.sendPrivate(targetId, `已转发给 ${this.router.ideLabel(channelId)}，正在流式同步回复…`, msgId);
    const stream: C2cStreamState = {
      streamMsgId: null,
      index: 0,
      sent: "",
      msgSeq: null,
      failed: false,
      finished: false,
      lastPushAt: 0,
      replyMsgId: msgId
    };
    let sealedText = "";
    let finalText = "";
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const clearIdle = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    };
    const armIdleSeal = () => {
      clearIdle();
      idleTimer = setTimeout(() => {
        void (async () => {
          if (!stream.streamMsgId || stream.finished) {
            return;
          }
          logger.info(
            { streamed: stream.sent.length },
            "QQ stream idle mid-turn, sealing segment with input_state=10 for desktop clients"
          );
          await this.finishC2cStream(targetId, msgId, stream);
          sealedText = stream.sent.replace(/\n$/, "").trim() || sealedText;
          this.resetC2cStreamSegment(stream);
        })();
      }, QQ_STREAM_IDLE_SEAL_MS);
    };
    try {
      const reply = await this.router.handle(channelId, text, {
        onProgress: async (event) => {
          const snapshot = event.content?.trim();
          if (!snapshot) {
            return;
          }
          await this.pushC2cStream(targetId, msgId, stream, snapshot, false);
          if (stream.streamMsgId && !stream.finished) {
            armIdleSeal();
          }
        }
      });
      clearIdle();
      finalText = (reply || stream.sent || sealedText || "").trim();
      if (!finalText) {
        await this.finishC2cStream(targetId, msgId, stream);
        await this.sendPrivate(targetId, "提示词已送达，但还没有捕获到完整回复。", msgId);
        return;
      }
      // Already sealed an identical segment during idle — nothing more to stream.
      if (!stream.streamMsgId && sealedText && finalText === sealedText) {
        return;
      }
      const closed = await this.pushC2cStream(targetId, msgId, stream, finalText, true);
      if (!closed) {
        await this.finishC2cStream(targetId, msgId, stream);
        logger.warn(
          { chars: finalText.length, streamed: stream.sent.length },
          "QQ stream incomplete after finalize attempt, sending full reply as normal text"
        );
        await this.sendPrivate(targetId, finalText, msgId, false);
      }
    } catch (error) {
      clearIdle();
      logger.warn({ error, targetId }, "QQ private stream relay failed");
      await this.finishC2cStream(targetId, msgId, stream);
      const fallback = (finalText || stream.sent || sealedText || "").trim();
      if (fallback) {
        await this.sendPrivate(targetId, fallback, msgId, false);
      } else {
        await this.sendPrivate(targetId, "请求失败，请查看 Courier 日志。", msgId);
      }
    } finally {
      clearIdle();
      // AstrBot #10066/#10069: missing input_state=10 → PC 「无法查看」/回滚.
      if (stream.streamMsgId && !stream.finished) {
        await this.finishC2cStream(targetId, msgId, stream);
      }
    }
  }

  /** After sealing a segment, allow the next progress snapshot to open a new stream. */
  private resetC2cStreamSegment(state: C2cStreamState): void {
    state.streamMsgId = null;
    state.index = 0;
    state.sent = "";
    state.msgSeq = null;
    state.failed = false;
    state.finished = false;
    state.lastPushAt = 0;
  }

  private async relayAndReply(
    targetId: string,
    msgId: string,
    text: string,
    kind: "private" | "group",
    memberOpenId?: string
  ): Promise<void> {
    const channelId = kind === "private" ? `qq:${targetId}` : `qq-group:${targetId}:${memberOpenId ?? ""}`;
    const send = (content: string, markdown = false) =>
      kind === "private"
        ? this.sendPrivate(targetId, content, msgId, markdown)
        : this.sendGroup(targetId, content, msgId, markdown);

    if (!this.isRelayText(text)) {
      const reply = await this.router.handle(channelId, text);
      await send(reply);
      return;
    }

    if (kind === "private") {
      await this.enqueuePrivateJob(targetId, msgId, () => this.relayPrivateStream(targetId, msgId, text, channelId));
      return;
    }

    await send(`已转发给 ${this.router.ideLabel(channelId)}，正在同步完整回复…`);
    let lastProgress = "";
    let lastProgressAt = 0;
    const reply = await this.router.handle(channelId, text, {
      onProgress: async (event) => {
        if (event.content) {
          return;
        }
        const formatted = this.formatProgress(event);
        const now = Date.now();
        if (formatted === lastProgress || now - lastProgressAt < 8000) {
          return;
        }
        lastProgress = formatted;
        lastProgressAt = now;
        await send(formatted);
      }
    });
    if (reply && reply !== lastProgress) {
      await send(reply, true);
    }
  }

  private stripMention(text: string): string {
    return text.replace(/<@!?\d+>/g, "").replace(/@\S+/g, "").trim();
  }

  private isIdentityCommand(text: string): boolean {
    const value = text.trim().toLowerCase();
    return value === "/whoami" || value === "/id" || value === "/openid";
  }

  private privateIdentityText(openId: string): string {
    return [
      "你的 QQ user_openid（填入 QQ_ALLOWED_OPEN_IDS）：",
      openId,
      "",
      "这不是 QQ 号，而是当前机器人签发的用户标识。复制到 .env 后重启 Courier。"
    ].join("\n");
  }

  private groupIdentityText(groupOpenId: string, memberOpenId: string): string {
    return [
      "本群 group_openid（填入 QQ_ALLOWED_GROUP_OPEN_IDS）：",
      groupOpenId,
      "",
      "你在本群的 member_openid：",
      memberOpenId || "（未获取到）",
      "",
      "QQ_ALLOWED_OPEN_IDS 需要的是私聊 user_openid。请私聊机器人发送 /whoami 获取。"
    ].join("\n");
  }

  private hasRequiredConfig(): boolean {
    return Boolean(config.qq.appId && config.qq.appSecret);
  }

  private registerNotifier(): void {
    if (this.registered) {
      return;
    }
    this.registered = true;
    notificationHub.register("qq", (text) => this.notifyAllowedUsers(text));
  }

  private async connectGateway(): Promise<void> {
    if (this.connecting) {
      return;
    }
    this.connecting = true;
    try {
      const token = await this.getAccessToken();
      const url = await this.getGatewayUrl(token);
      logger.info({ url }, "QQ WebSocket connecting");
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.addEventListener("open", () => {
        this.reconnectAttempt = 0;
      });
      ws.addEventListener("message", (event) => {
        this.onGatewayMessage(String(event.data));
      });
      ws.addEventListener("close", (event) => {
        logger.warn({ code: event.code, reason: event.reason }, "QQ WebSocket closed");
        this.cleanupSocket();
        this.scheduleReconnect();
      });
      ws.addEventListener("error", (event) => {
        logger.warn({ event }, "QQ WebSocket error");
      });
    } catch (error) {
      logger.warn({ error }, "QQ WebSocket connect failed");
      this.connecting = false;
      this.scheduleReconnect();
    }
  }

  private async getGatewayUrl(token: string): Promise<string> {
    const headers = {
      authorization: `QQBot ${token}`,
      "x-union-appid": config.qq.appId
    };
    for (const path of ["/gateway/bot", "/gateway"]) {
      const response = await fetch(`${config.qq.apiBase}${path}`, { headers });
      if (!response.ok) {
        continue;
      }
      const data = (await response.json()) as { url?: string };
      if (data.url) {
        return data.url;
      }
    }
    throw new Error("QQ gateway URL missing");
  }

  private onGatewayMessage(raw: string): void {
    let payload: QQWebhookPayload;
    try {
      payload = JSON.parse(raw) as QQWebhookPayload;
    } catch {
      logger.warn("QQ WebSocket received invalid JSON");
      return;
    }
    if (typeof payload.s === "number") {
      this.lastSeq = payload.s;
    }
    if (payload.op === 10) {
      this.startHeartbeat(payload.d?.heartbeat_interval ?? 45000);
      this.identifyOrResume();
      return;
    }
    if (payload.op === 7) {
      logger.info("QQ gateway requested reconnect");
      this.ws?.close();
      return;
    }
    if (payload.op === 9) {
      logger.warn("QQ WebSocket invalid session, identifying from scratch");
      this.sessionId = null;
      this.lastSeq = null;
      this.identifyOrResume();
      return;
    }
    if (payload.op === 0) {
      if (payload.t === "READY") {
        this.sessionId = payload.d?.session_id ?? this.sessionId;
        this.connecting = false;
        logger.info({ sessionId: this.sessionId }, "QQ WebSocket ready");
        return;
      }
      if (payload.t === "RESUMED") {
        this.connecting = false;
        logger.info("QQ WebSocket session resumed");
        return;
      }
      this.dispatchEvent(payload);
    }
  }

  private identifyOrResume(): void {
    const tokenPromise = this.getAccessToken();
    void tokenPromise
      .then((token) => {
        if (this.sessionId && this.lastSeq !== null) {
          this.sendGateway({
            op: 6,
            d: {
              token: `QQBot ${token}`,
              session_id: this.sessionId,
              seq: this.lastSeq
            }
          });
          return;
        }
        this.sendGateway({
          op: 2,
          d: {
            token: `QQBot ${token}`,
            intents: GROUP_AND_C2C_EVENT,
            shard: [0, 1],
            properties: {
              $os: process.platform,
              $browser: "courier",
              $device: "courier"
            }
          }
        });
      })
      .catch((error) => {
        logger.warn({ error }, "QQ identify failed");
      });
  }

  private startHeartbeat(intervalMs: number): void {
    this.stopHeartbeat();
    const beat = (): void => {
      this.sendGateway({ op: 1, d: this.lastSeq });
    };
    beat();
    this.heartbeatTimer = setInterval(beat, Math.max(5000, intervalMs));
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private sendGateway(payload: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.ws.send(JSON.stringify(payload));
  }

  private cleanupSocket(): void {
    this.stopHeartbeat();
    this.connecting = false;
    this.ws = null;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }
    this.reconnectAttempt += 1;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.reconnectAttempt, 5));
    logger.info({ delayMs: delay }, "QQ WebSocket reconnect scheduled");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectGateway();
    }, delay);
  }

  private sign(message: string): string {
    const key = createPrivateKey({
      key: ed25519PrivateKeyDer(config.qq.appSecret),
      format: "der",
      type: "pkcs8"
    });
    return sign(null, Buffer.from(message, "utf8"), key).toString("hex");
  }

  private verifyRequest(rawBody: string, headers: Record<string, string | undefined>): boolean {
    const signature = headers["x-signature-ed25519"] ?? headers["X-Signature-Ed25519"];
    const timestamp = headers["x-signature-timestamp"] ?? headers["X-Signature-Timestamp"];
    if (!signature || !timestamp) {
      logger.warn("QQ webhook missing signature headers");
      return false;
    }
    try {
      const privateKey = createPrivateKey({
        key: ed25519PrivateKeyDer(config.qq.appSecret),
        format: "der",
        type: "pkcs8"
      });
      const publicKey = createPublicKey(privateKey);
      return verify(
        null,
        Buffer.from(`${timestamp}${rawBody}`, "utf8"),
        publicKey,
        Buffer.from(signature, "hex")
      );
    } catch (error) {
      logger.warn({ error }, "QQ signature verify failed");
      return false;
    }
  }

  private async getAccessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) {
      return this.token.value;
    }
    const response = await fetch(`${config.qq.apiBase}/app/getAppAccessToken`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        appId: config.qq.appId,
        clientSecret: config.qq.appSecret
      })
    });
    const data = (await response.json()) as { access_token?: string; expires_in?: number | string };
    if (!response.ok || !data.access_token) {
      throw new Error(`QQ token request failed: ${response.status}`);
    }
    const ttl = Number(data.expires_in ?? 7200);
    this.token = {
      value: data.access_token,
      expiresAt: Date.now() + (Number.isFinite(ttl) ? ttl : 7200) * 1000
    };
    return this.token.value;
  }

  private async sendPrivate(openId: string, text: string, msgId?: string, markdown = false): Promise<void> {
    await this.sendChunks(`/v2/users/${encodeURIComponent(openId)}/messages`, text, msgId, markdown);
  }

  private async sendGroup(groupOpenId: string, text: string, msgId?: string, markdown = false): Promise<void> {
    await this.sendChunks(`/v2/groups/${encodeURIComponent(groupOpenId)}/messages`, text, msgId, markdown);
  }

  private async sendChunks(path: string, text: string, msgId?: string, markdown = false): Promise<void> {
    const token = await this.getAccessToken();
    const chunks = splitMessage(TextSecurityGuard.sanitizeOutbound(text), markdown ? 4000 : 1800);
    for (const content of chunks) {
      if (!content.trim()) {
        continue;
      }
      let usedMarkdown = markdown;
      let response = await this.postMessage(path, token, content, msgId, usedMarkdown);
      if (!response.ok && usedMarkdown) {
        const errBody = await response.text().catch(() => "");
        logger.warn({ status: response.status, errBody, path }, "QQ markdown send failed, retrying as text");
        usedMarkdown = false;
        response = await this.postMessage(path, token, content, msgId, false);
      }
      if (!response.ok && msgId) {
        const errBody = await response.text().catch(() => "");
        logger.warn({ status: response.status, errBody, path }, "QQ passive send failed, retrying as proactive");
        response = await this.postMessage(path, token, content, undefined, usedMarkdown);
      }
      if (!response.ok) {
        const errBody = await response.text().catch(() => "");
        throw new Error(`QQ send failed: ${response.status} ${errBody}`);
      }
      logger.info({ path, chars: content.length, markdown: usedMarkdown }, "QQ message sent");
    }
  }

  /**
   * Always seal with input_state=10 once a stream_msg_id exists.
   * Empty tail uses "\n" (AstrBot #10069). Final frame must end with "\n".
   */
  private async finishC2cStream(openId: string, msgId: string, state: C2cStreamState): Promise<void> {
    if (state.finished || !state.streamMsgId) {
      state.finished = true;
      return;
    }
    let closeContent = state.sent || "\n";
    if (!closeContent.endsWith("\n")) {
      closeContent = `${closeContent}\n`;
    }
    const previousFailed = state.failed;
    state.failed = false;
    const ok = await this.sendC2cStreamChunk(openId, msgId, state, closeContent, true);
    if (!ok) {
      state.failed = true;
      logger.warn(
        { streamedChars: state.sent.length, index: state.index },
        "QQ stream force-finish (input_state=10) failed"
      );
    }
    if (previousFailed) {
      state.failed = true;
    }
  }

  private async sendC2cStreamChunk(
    openId: string,
    msgId: string,
    state: C2cStreamState,
    contentRaw: string,
    done: boolean
  ): Promise<boolean> {
    // Official @tencent-connect/qqbot-nodejs and openclaw-qqbot only use markdown for
    // stream_messages. content_type=text is accepted by the API but PC QQ often shows
    // it as 「不支持的消息类型」/「必须要用手机客户端才能看」.
    const token = await this.getAccessToken();
    const anchor = state.replyMsgId || msgId;
    if (state.msgSeq === null) {
      const nextSeq = (this.seqByMsgId.get(anchor) ?? 0) + 1;
      this.seqByMsgId.set(anchor, nextSeq);
      state.msgSeq = nextSeq;
    }
    const body: Record<string, unknown> = {
      input_mode: "replace",
      input_state: done ? 10 : 1,
      index: state.index,
      content_type: "markdown",
      content_raw: contentRaw,
      msg_seq: state.msgSeq,
      msg_id: anchor,
      // Match qqbot-nodejs StreamSession: event_id defaults to the inbound msg id.
      event_id: anchor
    };
    if (state.streamMsgId) {
      body.stream_msg_id = state.streamMsgId;
    }
    const path = `/v2/users/${encodeURIComponent(openId)}/stream_messages`;
    const response = await fetch(`${config.qq.apiBase}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `QQBot ${token}`,
        "x-union-appid": config.qq.appId
      },
      body: JSON.stringify(body)
    });
    const raw = await response.text().catch(() => "");
    if (!response.ok) {
      // AstrBot: stream markdown frames must end with "\n".
      if (done && contentRaw && !contentRaw.endsWith("\n") && /\\n|换行|newline|40034021/i.test(raw)) {
        return await this.sendC2cStreamChunk(openId, msgId, state, `${contentRaw}\n`, true);
      }
      logger.warn(
        { status: response.status, errBody: raw, path, index: state.index, done },
        "QQ stream send failed"
      );
      return false;
    }
    let parsed: { id?: string; remain_msg_len?: number } = {};
    try {
      parsed = raw ? (JSON.parse(raw) as { id?: string; remain_msg_len?: number }) : {};
    } catch {
      parsed = {};
    }
    if (!state.streamMsgId && parsed.id) {
      state.streamMsgId = parsed.id;
    }
    // Store exact accepted content_raw — replace mode forbids changing this prefix.
    state.sent = contentRaw;
    state.index += 1;
    state.lastPushAt = Date.now();
    if (done) {
      state.finished = true;
    }
    logger.info(
      {
        path,
        chars: contentRaw.length,
        index: state.index,
        done,
        contentType: "markdown",
        remain: parsed.remain_msg_len ?? null
      },
      "QQ stream chunk sent"
    );
    return true;
  }

  private async pushC2cStream(
    openId: string,
    msgId: string,
    state: C2cStreamState,
    full: string,
    done: boolean
  ): Promise<boolean> {
    // A sealed idle segment sets finished=true; reopen for the next snapshot / final.
    if (state.finished && state.streamMsgId) {
      return true;
    }
    if (state.finished && !state.streamMsgId) {
      state.finished = false;
    }
    if (state.failed && !done) {
      return false;
    }
    const sanitized = TextSecurityGuard.sanitizeOutbound(full).trim();
    if (!sanitized && !done) {
      return true;
    }
    // Skip tiny first crumbs; avoid opening a stream on a 1-char flicker.
    if (!done && !state.streamMsgId && sanitized.length < 8) {
      return true;
    }
    // Throttle mid-stream updates (AstrBot uses ~1s).
    if (!done && state.streamMsgId && Date.now() - state.lastPushAt < QQ_STREAM_THROTTLE_MS) {
      return true;
    }
    const sentLogical = state.sent.replace(/\n$/, "");
    if (sentLogical && sanitized && sanitized.length < sentLogical.length && sentLogical.startsWith(sanitized)) {
      if (!done) {
        return true;
      }
    }
    // replace: content_raw must keep SentContent as prefix. Cursor DOM rewrites break that —
    // seal the old segment (AstrBot tool-break pattern) and start a fresh stream.
    const diverged = Boolean(sentLogical && sanitized && !sanitized.startsWith(sentLogical));
    if (diverged && state.streamMsgId) {
      logger.info(
        { prev: sentLogical.length, next: sanitized.length },
        "QQ stream prefix diverged, sealing segment and starting a new one"
      );
      await this.finishC2cStream(openId, msgId, state);
      this.resetC2cStreamSegment(state);
    }
    let next = sanitized || state.sent;
    if (next.length > QQ_STREAM_MAX_CHARS) {
      next = next.slice(0, QQ_STREAM_MAX_CHARS);
      if (state.sent && !next.startsWith(state.sent.replace(/\n$/, ""))) {
        next = state.sent;
      }
    }
    if (!next) {
      if (!done) {
        return true;
      }
      // Empty finalize placeholder — required once stream_msg_id exists.
      next = state.streamMsgId ? "\n" : "";
      if (!next) {
        return false;
      }
    }
    // Mid-stream: never append "\n" (poisons SentContent → 40007 on next replace).
    // Final: must end with "\n" (QQ API / AstrBot STREAM_MARKDOWN_NEWLINE_ERROR).
    if (done && !next.endsWith("\n")) {
      next = `${next}\n`;
    }
    if (!done && next === state.sent) {
      return true;
    }

    const ok = await this.sendC2cStreamChunk(openId, msgId, state, next, done);
    if (!ok) {
      logger.warn(
        { streamedChars: state.sent.length, index: state.index, done },
        "QQ stream unavailable, will finalize and fall back to normal messages"
      );
      state.failed = true;
      return false;
    }
    // Truncated to max chars — caller should plain-text the remainder.
    const acceptedLogical = state.sent.replace(/\n$/, "");
    if (done && sanitized.length > acceptedLogical.length && sanitized.startsWith(acceptedLogical)) {
      return false;
    }
    return true;
  }

  private async postMessage(
    path: string,
    token: string,
    content: string,
    msgId: string | undefined,
    markdown = false
  ): Promise<Response> {
    const body: Record<string, unknown> = markdown
      ? { msg_type: 2, markdown: { content } }
      : { content, msg_type: 0 };
    if (msgId) {
      body.msg_id = msgId;
      const nextSeq = (this.seqByMsgId.get(msgId) ?? 0) + 1;
      this.seqByMsgId.set(msgId, nextSeq);
      body.msg_seq = nextSeq;
    }
    return await fetch(`${config.qq.apiBase}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `QQBot ${token}`,
        "x-union-appid": config.qq.appId
      },
      body: JSON.stringify(body)
    });
  }
}
