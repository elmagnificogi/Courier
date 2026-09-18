import { config } from "../config";
import { logger } from "../logger";
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
      const reply = await this.router.handle(`wecom:${fromUser}`, text);
      await this.sendText(fromUser, reply);
    } catch (error) {
      logger.warn({ error, fromUser }, "WeCom command failed");
      await this.sendText(fromUser, "请求失败，请查看 Courier 日志。");
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
    const token = await this.getAccessToken();
    const chunks = splitMessage(text);
    for (const content of chunks) {
      const response = await fetch(`${config.wecom.apiBase}/cgi-bin/message/send?access_token=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          touser: toUser,
          msgtype: "text",
          agentid: config.wecom.agentId,
          text: { content }
        })
      });
      const data = (await response.json()) as { errcode?: number; errmsg?: string };
      if (!response.ok || (data.errcode && data.errcode !== 0)) {
        throw new Error(`WeCom send failed: ${data.errmsg ?? response.status}`);
      }
    }
  }
}
