import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { config } from "../config";
import { logger } from "../logger";
import { CommandRouter } from "./CommandRouter";
import { notificationHub } from "./NotificationHub";
import { HttpResult } from "./HttpResult";
import { ed25519PrivateKeyDer, MessageDeduper, splitMessage } from "./weixinCrypto";

interface TokenCache {
  value: string;
  expiresAt: number;
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
      logger.info({ userOpenId: openId, msgId }, "QQ C2C message received");
      if (this.deduper.seenBefore(`qq:c2c:${msgId || openId + text}`)) {
        return;
      }
      void this.processPrivate(openId, msgId, text).catch((error) => {
        logger.warn({ error, openId }, "QQ C2C handling failed");
      });
      return;
    }

    if (payload.t === "GROUP_AT_MESSAGE_CREATE" || payload.t === "GROUP_MESSAGE_CREATE") {
      const groupOpenId = payload.d?.group_openid ?? "";
      const memberOpenId = payload.d?.author?.member_openid || payload.d?.author?.id || "";
      const msgId = payload.d?.id ?? "";
      const text = this.stripMention((payload.d?.content ?? "").trim());
      logger.info({ groupOpenId, memberOpenId, msgId }, "QQ group message received");
      if (this.deduper.seenBefore(`qq:group:${msgId || groupOpenId + text}`)) {
        return;
      }
      void this.processGroup(groupOpenId, memberOpenId, msgId, text).catch((error) => {
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

  private async processPrivate(openId: string, msgId: string, text: string): Promise<void> {
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
        `未授权用户。\n你的 user_openid：\n${openId}\n请写入 QQ_ALLOWED_OPEN_IDS 后重启 Gantry。`,
        msgId
      );
      return;
    }
    if (!text) {
      await this.sendPrivate(openId, "请发送文本命令，例如 /help。", msgId);
      return;
    }
    try {
      await this.relayAndReply(openId, msgId, text, "private");
    } catch (error) {
      logger.warn({ error, openId }, "QQ command failed");
      await this.sendPrivate(openId, "请求失败，请查看 Gantry 日志。", msgId);
    }
  }

  private async processGroup(groupOpenId: string, memberOpenId: string, msgId: string, text: string): Promise<void> {
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
    if (!text) {
      await this.sendGroup(groupOpenId, "请发送文本命令，例如 /help。", msgId);
      return;
    }
    try {
      await this.relayAndReply(groupOpenId, msgId, text, "group", memberOpenId);
    } catch (error) {
      logger.warn({ error, groupOpenId }, "QQ group command failed");
      await this.sendGroup(groupOpenId, "请求失败，请查看 Gantry 日志。", msgId);
    }
  }

  private isRelayText(text: string): boolean {
    const value = text.trim();
    if (!value.startsWith("/")) {
      return true;
    }
    return /^\/(resume|choose)(\s|$)/i.test(value);
  }

  private isPendingCapture(text: string): boolean {
    const value = text.toLowerCase();
    return (
      text.includes("还没有捕获到回复") ||
      text.includes("回复超时") ||
      value.includes("response capture is pending") ||
      value.includes("pending or unavailable")
    );
  }

  private async relayAndReply(
    targetId: string,
    msgId: string,
    text: string,
    kind: "private" | "group",
    memberOpenId?: string
  ): Promise<void> {
    const channelId = kind === "private" ? `qq:${targetId}` : `qq-group:${targetId}:${memberOpenId ?? ""}`;
    const send = (content: string) =>
      kind === "private" ? this.sendPrivate(targetId, content, msgId) : this.sendGroup(targetId, content, msgId);

    if (this.isRelayText(text)) {
      await send("已转发给 Cursor，正在等待回复…");
    }

    const timeoutMs = Math.max(config.cursorActionTimeoutMs + 15_000, 45_000);
    const reply = await this.withTimeout(
      this.router.handle(channelId, text),
      timeoutMs,
      "Cursor 回复超时。可稍后发送 /last 获取刚才的助手回复。"
    );
    await send(reply);

    if (this.isRelayText(text) && this.isPendingCapture(reply)) {
      await this.sendDelayedFollowup(channelId, send, reply);
    }
  }

  private async withTimeout(task: Promise<string>, timeoutMs: number, timeoutMessage: string): Promise<string> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve(timeoutMessage), timeoutMs);
    });
    try {
      return await Promise.race([task, timeout]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private async sendDelayedFollowup(
    channelId: string,
    send: (content: string) => Promise<void>,
    previous: string,
    maxWaitMs = 60_000
  ): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < maxWaitMs) {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      const latest = await this.router.handle(channelId, "/last");
      if (
        latest &&
        latest !== previous &&
        !this.isPendingCapture(latest) &&
        !latest.includes("还没有助手回复")
      ) {
        await send(latest);
        return;
      }
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
      "这不是 QQ 号，而是当前机器人签发的用户标识。复制到 .env 后重启 Gantry。"
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
              $browser: "gantry",
              $device: "gantry"
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

  private async sendPrivate(openId: string, text: string, msgId?: string): Promise<void> {
    await this.sendChunks(`/v2/users/${encodeURIComponent(openId)}/messages`, text, msgId);
  }

  private async sendGroup(groupOpenId: string, text: string, msgId?: string): Promise<void> {
    await this.sendChunks(`/v2/groups/${encodeURIComponent(groupOpenId)}/messages`, text, msgId);
  }

  private async sendChunks(path: string, text: string, msgId?: string): Promise<void> {
    const token = await this.getAccessToken();
    const chunks = splitMessage(text);
    for (const content of chunks) {
      if (!content.trim()) {
        continue;
      }
      let response = await this.postMessage(path, token, content, msgId);
      if (!response.ok && msgId) {
        const errBody = await response.text().catch(() => "");
        logger.warn({ status: response.status, errBody, path }, "QQ passive send failed, retrying as proactive");
        response = await this.postMessage(path, token, content);
      }
      if (!response.ok) {
        const errBody = await response.text().catch(() => "");
        throw new Error(`QQ send failed: ${response.status} ${errBody}`);
      }
      logger.info({ path, chars: content.length }, "QQ message sent");
    }
  }

  private async postMessage(
    path: string,
    token: string,
    content: string,
    msgId?: string
  ): Promise<Response> {
    const body: Record<string, unknown> = {
      content,
      msg_type: 0
    };
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
