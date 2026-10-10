import WebSocket from "ws";
import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { config, ideDisplayName } from "../config";
import { logger } from "../logger";
import { AgentProgressEvent } from "../types";
import { CommandRouter } from "./CommandRouter";
import { notificationHub } from "./NotificationHub";
import { MessageDeduper } from "./weixinCrypto";
import { decryptAibotMedia, filenameFromContentDisposition, sanitizeFileName } from "./wecomAibotCrypto";
import { collectWecomAibotInbound, stripWecomMention, WecomAibotBody } from "./wecomAibotMessages";

const STREAM_MAX_CHARS = 20000;
const MEDIA_MAX_BYTES = 15 * 1024 * 1024;
const HEARTBEAT_MS = 30_000;

interface AibotFrame {
  cmd?: string;
  headers?: { req_id?: string };
  errcode?: number;
  errmsg?: string;
  body?: WecomAibotBody & {
    msgid?: string;
    chatid?: string;
    chattype?: string;
    from?: { userid?: string };
    event?: { eventtype?: string };
  };
}

interface PendingAck {
  reqId: string;
  done: (ok: boolean) => void;
}

export class WeComAibotService {
  private readonly router = new CommandRouter();
  private readonly deduper = new MessageDeduper();
  private ws: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private socketGeneration = 0;
  private stopped = false;
  private authenticated = false;
  private registered = false;
  private missedPong = 0;
  private replyChain: Promise<void> = Promise.resolve();
  private pendingAck: PendingAck | null = null;
  private readonly lastStreamAt = new Map<string, number>();

  enabled(): boolean {
    return config.wecomAibot.enabled && this.hasRequiredConfig();
  }

  start(): void {
    if (!config.wecomAibot.enabled) {
      logger.info("WeCom intelligent robot adapter disabled");
      return;
    }
    if (!this.hasRequiredConfig()) {
      logger.warn("WeCom intelligent robot enabled but bot id / secret is incomplete");
      return;
    }
    this.stopped = false;
    this.registerNotifier();
    this.connect();
    logger.info("WeCom intelligent robot adapter connecting (WebSocket, no public URL required)");
  }

  async notifyAllowedUsers(text: string): Promise<void> {
    if (!this.enabled() || !this.authenticated) {
      return;
    }
    for (const userId of config.wecomAibot.allowedUserIds) {
      try {
        await this.sendCmd(`aibot_send_msg-${Date.now()}-${userId}`, "aibot_send_msg", {
          chatid: userId,
          msgtype: "markdown",
          markdown: { content: clipStream(text) }
        });
      } catch (error) {
        logger.warn({ error, userId }, "WeCom intelligent robot notify failed");
      }
    }
  }

  private hasRequiredConfig(): boolean {
    return Boolean(config.wecomAibot.botId && config.wecomAibot.secret);
  }

  private registerNotifier(): void {
    if (this.registered) {
      return;
    }
    this.registered = true;
    notificationHub.register("wecom-aibot", (text) => this.notifyAllowedUsers(text));
  }

  private connect(): void {
    if (this.stopped) {
      return;
    }
    const generation = ++this.socketGeneration;
    this.clearSocket();
    const ws = new WebSocket(config.wecomAibot.wsUrl, { perMessageDeflate: false });
    this.ws = ws;
    ws.on("open", () => {
      if (generation !== this.socketGeneration) {
        return;
      }
      this.authenticated = false;
      this.missedPong = 0;
      const reqId = `aibot_subscribe-${Date.now()}`;
      this.sendRaw({
        cmd: "aibot_subscribe",
        headers: { req_id: reqId },
        body: {
          bot_id: config.wecomAibot.botId,
          secret: config.wecomAibot.secret
        }
      });
      logger.info("WeCom intelligent robot auth frame sent");
    });
    ws.on("message", (data) => {
      if (generation !== this.socketGeneration) {
        return;
      }
      const raw = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
      this.onSocketMessage(raw);
    });
    ws.on("close", (code, reason) => {
      if (generation !== this.socketGeneration) {
        return;
      }
      const reasonText = Buffer.isBuffer(reason) ? reason.toString("utf8") : "";
      logger.info({ code, reason: reasonText }, "WeCom intelligent robot websocket closed");
      this.authenticated = false;
      this.stopHeartbeat();
      this.failPendingAck();
      if (!this.stopped) {
        this.scheduleReconnect();
      }
    });
    ws.on("error", (error) => {
      logger.warn({ message: error.message }, "WeCom intelligent robot websocket error");
    });
  }

  private onSocketMessage(raw: string): void {
    let frame: AibotFrame;
    try {
      frame = JSON.parse(raw.replace(/[\u0000-\u0008\u000B-\u000D\u000E-\u001F]/g, "")) as AibotFrame;
    } catch (error) {
      logger.warn({ error }, "WeCom intelligent robot frame parse failed");
      return;
    }
    const reqId = frame.headers?.req_id ?? "";
    if (frame.cmd === "aibot_msg_callback") {
      void this.handleMessage(frame).catch((error) => {
        logger.warn({ error }, "WeCom intelligent robot message handling failed");
      });
      return;
    }
    if (frame.cmd === "aibot_event_callback") {
      const eventType = frame.body?.event?.eventtype ?? "";
      if (eventType === "disconnected_event") {
        logger.warn("WeCom intelligent robot disconnected because another connection took over");
      }
      return;
    }
    if (reqId.startsWith("aibot_subscribe")) {
      if (frame.errcode !== 0) {
        logger.error({ errcode: frame.errcode, errmsg: frame.errmsg }, "WeCom intelligent robot auth failed");
        this.ws?.close();
        return;
      }
      this.authenticated = true;
      this.reconnectAttempt = 0;
      this.startHeartbeat();
      logger.info("WeCom intelligent robot authenticated");
      return;
    }
    if (reqId.startsWith("ping")) {
      this.missedPong = 0;
      return;
    }
    if (this.pendingAck && this.pendingAck.reqId === reqId) {
      const done = this.pendingAck.done;
      this.pendingAck = null;
      done(frame.errcode === 0);
    }
  }

  private async handleMessage(frame: AibotFrame): Promise<void> {
    const body = frame.body;
    const reqId = frame.headers?.req_id ?? "";
    if (!body || !reqId) {
      return;
    }
    const userId = body.from?.userid ?? "";
    const msgId = body.msgid ?? "";
    if (this.deduper.seenBefore(`wecom-aibot:${msgId || reqId}`)) {
      return;
    }
    const chatType = body.chattype === "group" ? "group" : "single";
    const channelId =
      chatType === "group" ? `wecom-aibot-group:${body.chatid ?? ""}:${userId}` : `wecom-aibot:${userId}`;
    const inbound = collectWecomAibotInbound(body);
    const text = stripWecomMention(inbound.text);
    logger.info(
      { userId, chatType, msgType: body.msgtype, media: inbound.media.length },
      "WeCom intelligent robot message received"
    );

    if (this.isIdentityCommand(text)) {
      await this.replyText(reqId, this.identityText(userId, chatType, body.chatid ?? ""));
      return;
    }
    if (config.wecomAibot.allowedUserIds.length > 0 && userId && !config.wecomAibot.allowedUserIds.includes(userId)) {
      await this.replyText(
        reqId,
        `未授权用户。\n你的 userid：\n${userId}\n请写入 WECOM_AIBOT_ALLOWED_USER_IDS 后重启 Courier。`
      );
      return;
    }
    if (!userId) {
      return;
    }
    if (inbound.media.length > 0) {
      await this.handleMedia(channelId, reqId, text, inbound.media);
      return;
    }
    if (!text) {
      await this.replyText(reqId, "暂不支持这种消息。请发送文字、图片或文件。");
      return;
    }
    await this.relayText(channelId, reqId, text);
  }

  private async handleMedia(
    channelId: string,
    reqId: string,
    text: string,
    media: Array<{ kind: "image" | "file"; url: string; aeskey: string }>
  ): Promise<void> {
    const streamId = `stream-${reqId}`;
    try {
      let lastReply = "";
      for (let index = 0; index < media.length; index += 1) {
        const item = media[index];
        if (!item) {
          continue;
        }
        const downloaded = await this.downloadMedia(item);
        const isLast = index === media.length - 1;
        const prompt = isLast ? text.trim() : "";
        const options: {
          fileName: string;
          mimeType?: string;
          prompt?: string;
          onProgress?: (event: AgentProgressEvent) => Promise<void>;
        } = { fileName: downloaded.fileName };
        if (downloaded.mimeType) {
          options.mimeType = downloaded.mimeType;
        }
        if (prompt && this.isRelayText(prompt)) {
          options.prompt = prompt;
          options.onProgress = async (event) => {
            const snapshot = event.content?.trim();
            if (snapshot) {
              await this.pushStream(reqId, streamId, snapshot, false);
            }
          };
          await this.pushStream(reqId, streamId, `已收到${item.kind === "image" ? "图片" : "文件"}，正在转发给 ${ideDisplayName()}…`, false);
          lastReply = await this.router.attachMedia(
            channelId,
            downloaded.path,
            item.kind === "image" ? "photo" : "document",
            options
          );
        } else {
          lastReply = await this.router.attachMedia(channelId, downloaded.path, item.kind === "image" ? "photo" : "document", options);
        }
      }
      await this.pushStream(reqId, streamId, lastReply || "附件已处理。", true);
    } catch (error) {
      logger.warn({ error, channelId }, "WeCom intelligent robot media failed");
      await this.replyText(reqId, "图片或文件下载失败。请再发一次，或把文件存到电脑后用 /attach 绝对路径。");
    }
  }

  private async relayText(channelId: string, reqId: string, text: string): Promise<void> {
    if (!this.isRelayText(text)) {
      const reply = await this.router.handle(channelId, text);
      await this.replyText(reqId, reply);
      return;
    }
    const streamId = `stream-${reqId}`;
    await this.pushStream(reqId, streamId, `已转发给 ${ideDisplayName()}，正在同步回复…`, false);
    try {
      const reply = await this.router.handle(channelId, text, {
        onProgress: async (event) => {
          const snapshot = event.content?.trim();
          if (snapshot) {
            await this.pushStream(reqId, streamId, snapshot, false);
          }
        }
      });
      await this.pushStream(reqId, streamId, reply, true);
    } catch (error) {
      logger.warn({ error, channelId }, "WeCom intelligent robot relay failed");
      await this.pushStream(reqId, streamId, "请求失败，请查看 Courier 日志。", true);
    }
  }

  private async replyText(reqId: string, text: string): Promise<void> {
    const streamId = `stream-${reqId}`;
    await this.pushStream(reqId, streamId, text, true);
  }

  private async pushStream(reqId: string, streamId: string, content: string, finish: boolean): Promise<void> {
    const now = Date.now();
    const last = this.lastStreamAt.get(reqId) ?? 0;
    if (!finish && now - last < 1200) {
      return;
    }
    this.lastStreamAt.set(reqId, now);
    await this.sendCmd(reqId, "aibot_respond_msg", {
      msgtype: "stream",
      stream: {
        id: streamId,
        finish,
        content: clipStream(content)
      }
    });
    if (finish) {
      this.lastStreamAt.delete(reqId);
    }
  }

  private async downloadMedia(item: { kind: "image" | "file"; url: string; aeskey: string }): Promise<{
    path: string;
    fileName: string;
    mimeType?: string;
  }> {
    const response = await fetch(item.url);
    if (!response.ok) {
      throw new Error(`WeCom media download failed: ${response.status}`);
    }
    const encrypted = Buffer.from(await response.arrayBuffer());
    if (encrypted.length > MEDIA_MAX_BYTES) {
      throw new Error("WeCom media exceeds size limit");
    }
    const plain = item.aeskey ? decryptAibotMedia(encrypted, item.aeskey) : encrypted;
    const headerName = filenameFromContentDisposition(response.headers.get("content-disposition"));
    const fileName = headerName || sniffedFileName(plain, item.kind);
    const downloadDir = join(process.cwd(), "tmp", "wecom-aibot");
    mkdirSync(downloadDir, { recursive: true });
    const filePath = join(downloadDir, `${Date.now()}-${sanitizeFileName(fileName) || fileName}`);
    await writeFile(filePath, plain);
    const downloaded: { path: string; fileName: string; mimeType?: string } = { path: filePath, fileName };
    const mime = mimeFromName(fileName);
    if (mime) {
      downloaded.mimeType = mime;
    }
    logger.info({ filePath, bytes: plain.length, kind: item.kind }, "WeCom intelligent robot media saved");
    return downloaded;
  }

  private sendCmd(reqId: string, cmd: string, body: Record<string, unknown>): Promise<void> {
    const run = this.replyChain.then(() => this.sendCmdNow(reqId, cmd, body));
    this.replyChain = run.catch(() => undefined);
    return run;
  }

  private sendCmdNow(reqId: string, cmd: string, body: Record<string, unknown>): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pendingAck?.reqId === reqId) {
          this.pendingAck = null;
        }
        logger.warn({ cmd }, "WeCom intelligent robot reply ack timeout");
        resolve();
      }, 8000);
      this.pendingAck = {
        reqId,
        done: () => {
          clearTimeout(timer);
          resolve();
        }
      };
      this.sendRaw({ cmd, headers: { req_id: reqId }, body });
    });
  }

  private sendRaw(frame: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.ws.send(JSON.stringify(frame));
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.missedPong >= 3) {
        logger.warn("WeCom intelligent robot heartbeat timed out, reconnecting");
        this.ws?.close();
        return;
      }
      this.missedPong += 1;
      this.sendRaw({
        cmd: "ping",
        headers: { req_id: `ping-${Date.now()}` }
      });
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopped) {
      return;
    }
    this.reconnectAttempt += 1;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.reconnectAttempt, 5));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private failPendingAck(): void {
    if (!this.pendingAck) {
      return;
    }
    const done = this.pendingAck.done;
    this.pendingAck = null;
    done(false);
  }

  private clearSocket(): void {
    this.stopHeartbeat();
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
  }

  private isIdentityCommand(text: string): boolean {
    const value = text.trim().toLowerCase();
    return value === "/whoami" || value === "/id" || value === "/userid";
  }

  private identityText(userId: string, chatType: string, chatId: string): string {
    if (chatType === "group") {
      return [`群聊 chatid（仅供排查）：`, chatId || "（空）", "", "你的 userid：", userId || "（空）"].join("\n");
    }
    return ["你的企业微信 userid（填入 WECOM_AIBOT_ALLOWED_USER_IDS）：", userId || "（空）"].join("\n");
  }

  private isRelayText(text: string): boolean {
    const value = text.trim();
    if (!value.startsWith("/")) {
      return true;
    }
    return /^\/(resume|choose)(\s|$)/i.test(value);
  }
}

function clipStream(text: string): string {
  const value = text.trim() || "（空回复）";
  if (value.length <= STREAM_MAX_CHARS) {
    return value;
  }
  return `${value.slice(0, STREAM_MAX_CHARS - 20)}\n\n…（已截断）`;
}

function sniffedFileName(buffer: Buffer, kind: "image" | "file"): string {
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return "wecom-image.png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "wecom-image.jpg";
  }
  if (buffer.length >= 4 && buffer.subarray(0, 4).toString("utf8") === "%PDF") {
    return "wecom-file.pdf";
  }
  if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b) {
    return "wecom-file.zip";
  }
  return kind === "image" ? "wecom-image.jpg" : "wecom-file.bin";
}

function mimeFromName(fileName: string): string | undefined {
  const ext = extname(fileName).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".txt") return "text/plain";
  if (ext === ".md") return "text/markdown";
  if (ext === ".json") return "application/json";
  if (ext === ".zip") return "application/zip";
  return undefined;
}
