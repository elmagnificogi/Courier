import { config } from "../config";
import { logger } from "../logger";
import { AgentProgressEvent } from "../types";
import { CommandRouter } from "./CommandRouter";
import { notificationHub } from "./NotificationHub";
import { HttpResult } from "./HttpResult";
import {
  decryptWeixinMessage,
  MessageDeduper,
  sha1Signature,
  splitMessage,
  xmlTag
} from "./weixinCrypto";

interface TokenCache {
  value: string;
  expiresAt: number;
}

export class WeComService {
  private readonly router = new CommandRouter();
  private readonly deduper = new MessageDeduper();
  /** Serialize per-user Cursor jobs so overlapping WeCom prompts do not race one Composer. */
  private readonly userQueue = new Map<string, Promise<void>>();
  private readonly userQueueDepth = new Map<string, number>();
  private token: TokenCache | null = null;
  private registered = false;

  enabled(): boolean {
    return config.wecom.enabled && this.hasRequiredConfig();
  }

  start(): void {
    if (!config.wecom.enabled) {
      logger.info("WeCom adapter disabled");
      return;
    }
    if (!this.hasRequiredConfig()) {
      logger.warn("WeCom adapter enabled but corp id / agent / secret / token / AES key is incomplete");
      return;
    }
    this.registerNotifier();
    logger.info("WeCom adapter ready (callback: POST /platform/wecom/callback)");
  }

  async handleRequest(
    method: string,
    query: URLSearchParams,
    rawBody: string
  ): Promise<HttpResult> {
    if (!this.enabled()) {
      return { status: 404, body: "wecom adapter disabled" };
    }

    const timestamp = query.get("timestamp") ?? "";
    const nonce = query.get("nonce") ?? "";
    const msgSignature = query.get("msg_signature") ?? "";

    if (method === "GET") {
      const echostr = query.get("echostr") ?? "";
      if (!this.verifySignature(msgSignature, timestamp, nonce, echostr)) {
        return { status: 401, body: "invalid signature" };
      }
      try {
        const echo = decryptWeixinMessage(echostr, config.wecom.aesKey, config.wecom.corpId);
        return { status: 200, body: echo, contentType: "text/plain; charset=utf-8" };
      } catch (error) {
        logger.warn({ error }, "WeCom URL verification decrypt failed");
        return { status: 401, body: "invalid echostr" };
      }
    }

    if (method !== "POST") {
      return { status: 405, body: "method not allowed" };
    }

    const encrypt = xmlTag(rawBody, "Encrypt");
    if (!encrypt) {
      return { status: 400, body: "missing encrypt" };
    }
    if (!this.verifySignature(msgSignature, timestamp, nonce, encrypt)) {
      return { status: 401, body: "invalid signature" };
    }

    let xml: string;
    try {
      xml = decryptWeixinMessage(encrypt, config.wecom.aesKey, config.wecom.corpId);
    } catch (error) {
      logger.warn({ error }, "WeCom decrypt failed");
      return { status: 401, body: "invalid encrypt" };
    }

    const msgId = xmlTag(xml, "MsgId") || xmlTag(xml, "MsgID");
    if (this.deduper.seenBefore(`wecom:${msgId || encrypt}`)) {
      return { status: 200, body: "success", contentType: "text/plain; charset=utf-8" };
    }

    const fromUser = xmlTag(xml, "FromUserName");
    const msgType = xmlTag(xml, "MsgType").toLowerCase();
    const text = this.extractText(xml, msgType);
    void this.processMessage(fromUser, text).catch((error) => {
      logger.warn({ error, fromUser }, "WeCom message handling failed");
    });
    return { status: 200, body: "success", contentType: "text/plain; charset=utf-8" };
  }

  async notifyAllowedUsers(text: string): Promise<void> {
    if (!this.enabled()) {
      return;
    }
    for (const userId of config.wecom.allowedUserIds) {
      try {
        await this.sendText(userId, text);
      } catch (error) {
        logger.warn({ error, userId }, "WeCom notify failed");
      }
    }
  }

  private extractText(xml: string, msgType: string): string {
    if (msgType === "text") {
      return xmlTag(xml, "Content").trim();
    }
    if (msgType === "voice") {
      return xmlTag(xml, "Recognition").trim();
    }
    return "";
  }

  private isRelayText(text: string): boolean {
    const value = text.trim();
    if (!value.startsWith("/")) {
      return true;
    }
    return /^\/(resume|choose)(\s|$)/i.test(value);
  }

  private async enqueueUserJob(userId: string, job: () => Promise<void>, onQueued?: (ahead: number) => Promise<void>): Promise<void> {
    const depth = (this.userQueueDepth.get(userId) ?? 0) + 1;
    this.userQueueDepth.set(userId, depth);
    if (depth > 1 && onQueued) {
      await onQueued(depth - 1);
    }
    const previous = this.userQueue.get(userId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => {
      try {
        await job();
      } finally {
        const left = Math.max(0, (this.userQueueDepth.get(userId) ?? 1) - 1);
        if (left === 0) {
          this.userQueueDepth.delete(userId);
        } else {
          this.userQueueDepth.set(userId, left);
        }
      }
    });
    this.userQueue.set(
      userId,
      run.finally(() => {
        if (this.userQueue.get(userId) === run) {
          this.userQueue.delete(userId);
        }
      })
    );
    await run;
  }

  private async processMessage(fromUser: string, text: string): Promise<void> {
    if (!fromUser) {
      return;
    }
    if (config.wecom.allowedUserIds.length > 0 && !config.wecom.allowedUserIds.includes(fromUser)) {
      await this.sendText(fromUser, "未授权用户。");
      return;
    }
    if (!text) {
      await this.sendText(
        fromUser,
        "暂不支持这种消息类型。请发送文本命令，或在 Telegram 使用 /attach <绝对路径>。"
      );
      return;
    }
    try {
      if (!this.isRelayText(text)) {
        const reply = await this.router.handle(`wecom:${fromUser}`, text);
        await this.sendText(fromUser, reply);
        return;
      }
      await this.enqueueUserJob(
        fromUser,
        () => this.relayPrompt(fromUser, text),
        async (ahead) => {
          await this.sendText(fromUser, `已收到，前面还有 ${ahead} 个任务在跑，会按顺序单独回复，不会混在一起。`);
        }
      );
    } catch (error) {
      logger.warn({ error, fromUser }, "WeCom command failed");
      await this.sendText(fromUser, "请求失败，请查看 Courier 日志。");
    }
  }

  private async relayPrompt(fromUser: string, text: string): Promise<void> {
    const channelId = `wecom:${fromUser}`;
    await this.sendText(fromUser, `已转发给 ${this.router.ideLabel(channelId)}，正在同步完整回复…`);
    let lastProgress = "";
    let lastProgressAt = 0;
    const reply = await this.router.handle(channelId, text, {
      onProgress: async (event: AgentProgressEvent) => {
        const snapshot = event.content?.trim();
        if (snapshot) {
          // Classic WeCom has no in-place stream edit; only ping phase changes to avoid flooding.
          return;
        }
        const formatted = event.text?.trim();
        if (!formatted) {
          return;
        }
        const now = Date.now();
        if (formatted === lastProgress || now - lastProgressAt < 8000) {
          return;
        }
        lastProgress = formatted;
        lastProgressAt = now;
        await this.sendText(fromUser, formatted);
      }
    });
    if (reply && reply !== lastProgress) {
      await this.sendMarkdownOrText(fromUser, reply);
    } else if (!reply) {
      await this.sendText(fromUser, "提示词已送达，但还没有捕获到完整回复。");
    }
  }

  private async sendMarkdownOrText(toUser: string, text: string): Promise<void> {
    try {
      await this.sendMarkdown(toUser, text);
    } catch (error) {
      logger.warn({ error, toUser }, "WeCom markdown send failed, falling back to text");
      await this.sendText(toUser, text);
    }
  }

  private verifySignature(signature: string, timestamp: string, nonce: string, encrypt: string): boolean {
    if (!signature || !timestamp || !nonce || !encrypt) {
      return false;
    }
    const expected = sha1Signature([config.wecom.token, timestamp, nonce, encrypt]);
    return expected === signature;
  }

  private hasRequiredConfig(): boolean {
    return Boolean(
      config.wecom.corpId &&
        config.wecom.agentId &&
        config.wecom.secret &&
        config.wecom.token &&
        config.wecom.aesKey
    );
  }

  private registerNotifier(): void {
    if (this.registered) {
      return;
    }
    this.registered = true;
    notificationHub.register("wecom", (text) => this.notifyAllowedUsers(text));
  }

  private async getAccessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) {
      return this.token.value;
    }
    const url = `${config.wecom.apiBase}/cgi-bin/gettoken?corpid=${encodeURIComponent(config.wecom.corpId)}&corpsecret=${encodeURIComponent(config.wecom.secret)}`;
    const response = await fetch(url);
    const data = (await response.json()) as { access_token?: string; expires_in?: number; errmsg?: string };
    if (!response.ok || !data.access_token) {
      throw new Error(`WeCom token request failed: ${data.errmsg ?? response.status}`);
    }
    this.token = {
      value: data.access_token,
      expiresAt: Date.now() + (data.expires_in ?? 7200) * 1000
    };
    return this.token.value;
  }

  private async sendText(toUser: string, text: string): Promise<void> {
    await this.sendChunks(toUser, text, "text");
  }

  private async sendMarkdown(toUser: string, text: string): Promise<void> {
    await this.sendChunks(toUser, text, "markdown");
  }

  private async sendChunks(toUser: string, text: string, kind: "text" | "markdown"): Promise<void> {
    const token = await this.getAccessToken();
    const chunks = splitMessage(text, kind === "markdown" ? 2000 : 1800);
    for (const content of chunks) {
      if (!content.trim()) {
        continue;
      }
      const body: Record<string, unknown> =
        kind === "markdown"
          ? {
              touser: toUser,
              msgtype: "markdown",
              agentid: config.wecom.agentId,
              markdown: { content }
            }
          : {
              touser: toUser,
              msgtype: "text",
              agentid: config.wecom.agentId,
              text: { content }
            };
      const response = await fetch(
        `${config.wecom.apiBase}/cgi-bin/message/send?access_token=${encodeURIComponent(token)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body)
        }
      );
      const data = (await response.json()) as { errcode?: number; errmsg?: string };
      if (!response.ok || (data.errcode && data.errcode !== 0)) {
        throw new Error(`WeCom send failed: ${data.errmsg ?? response.status}`);
      }
    }
  }
}
