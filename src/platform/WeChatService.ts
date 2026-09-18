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

export class WeChatService {
  private readonly router = new CommandRouter();
  private readonly deduper = new MessageDeduper();
  private token: TokenCache | null = null;
  private registered = false;

  enabled(): boolean {
    return config.wechat.enabled && this.hasRequiredConfig();
  }

  start(): void {
    if (!config.wechat.enabled) {
      logger.info("WeChat Official Account adapter disabled");
      return;
    }
    if (!this.hasRequiredConfig()) {
      logger.warn("WeChat adapter enabled but app id / secret / token is incomplete");
      return;
    }
    this.registerNotifier();
    logger.info("WeChat Official Account adapter ready (callback: POST /platform/wechat/callback)");
  }

  async handleRequest(
    method: string,
    query: URLSearchParams,
    rawBody: string
  ): Promise<HttpResult> {
    if (!this.enabled()) {
      return { status: 404, body: "wechat adapter disabled" };
    }

    const timestamp = query.get("timestamp") ?? "";
    const nonce = query.get("nonce") ?? "";

    if (method === "GET") {
      const signature = query.get("signature") ?? "";
      const echostr = query.get("echostr") ?? "";
      const expected = sha1Signature([config.wechat.token, timestamp, nonce]);
      if (!signature || expected !== signature) {
        return { status: 401, body: "invalid signature" };
      }
      return { status: 200, body: echostr, contentType: "text/plain; charset=utf-8" };
    }

    if (method !== "POST") {
      return { status: 405, body: "method not allowed" };
    }

    let xml = rawBody;
    const encrypt = xmlTag(rawBody, "Encrypt");
    if (encrypt) {
      const msgSignature = query.get("msg_signature") ?? "";
      if (!this.verifyEncryptSignature(msgSignature, timestamp, nonce, encrypt)) {
        return { status: 401, body: "invalid signature" };
      }
      try {
        xml = decryptWeixinMessage(encrypt, config.wechat.aesKey, config.wechat.appId);
      } catch (error) {
        logger.warn({ error }, "WeChat decrypt failed");
        return { status: 401, body: "invalid encrypt" };
      }
    } else {
      const signature = query.get("signature") ?? "";
      const expected = sha1Signature([config.wechat.token, timestamp, nonce]);
      if (signature && expected !== signature) {
        return { status: 401, body: "invalid signature" };
      }
    }

    const msgId = xmlTag(xml, "MsgId") || xmlTag(xml, "MsgID");
    if (this.deduper.seenBefore(`wechat:${msgId || xml}`)) {
      return { status: 200, body: "success", contentType: "text/plain; charset=utf-8" };
    }

    const fromUser = xmlTag(xml, "FromUserName");
    const msgType = xmlTag(xml, "MsgType").toLowerCase();
    const text = this.extractText(xml, msgType);
    void this.processMessage(fromUser, text).catch((error) => {
      logger.warn({ error, fromUser }, "WeChat message handling failed");
    });
    return { status: 200, body: "success", contentType: "text/plain; charset=utf-8" };
  }

  async notifyAllowedUsers(text: string): Promise<void> {
    if (!this.enabled()) {
      return;
    }
    for (const openId of config.wechat.allowedOpenIds) {
      try {
        await this.sendText(openId, text);
      } catch (error) {
        logger.warn({ error, openId }, "WeChat notify failed");
      }
    }
  }

  private extractText(xml: string, msgType: string): string {
    if (msgType === "text") {
      return xmlTag(xml, "Content").trim();
    }
    if (msgType === "voice" || msgType === "shortvideo") {
      return xmlTag(xml, "Recognition").trim();
    }
    return "";
  }

  private async processMessage(fromUser: string, text: string): Promise<void> {
    if (!fromUser) {
      return;
    }
    if (config.wechat.allowedOpenIds.length > 0 && !config.wechat.allowedOpenIds.includes(fromUser)) {
      await this.sendText(fromUser, "未授权用户。");
      return;
    }
    if (!text) {
      await this.sendText(
        fromUser,
        "暂不支持这种消息类型。请发送文本命令，例如 /help。"
      );
      return;
    }
    try {
      const reply = await this.router.handle(`wechat:${fromUser}`, text);
      await this.sendText(fromUser, reply);
    } catch (error) {
      logger.warn({ error, fromUser }, "WeChat command failed");
      await this.sendText(fromUser, "请求失败，请查看 Gantry 日志。");
    }
  }

  private verifyEncryptSignature(signature: string, timestamp: string, nonce: string, encrypt: string): boolean {
    if (!signature || !config.wechat.aesKey) {
      return false;
    }
    return sha1Signature([config.wechat.token, timestamp, nonce, encrypt]) === signature;
  }

  private hasRequiredConfig(): boolean {
    return Boolean(config.wechat.appId && config.wechat.appSecret && config.wechat.token);
  }

  private registerNotifier(): void {
    if (this.registered) {
      return;
    }
    this.registered = true;
    notificationHub.register("wechat", (text) => this.notifyAllowedUsers(text));
  }

  private async getAccessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) {
      return this.token.value;
    }
    const url = `${config.wechat.apiBase}/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(config.wechat.appId)}&secret=${encodeURIComponent(config.wechat.appSecret)}`;
    const response = await fetch(url);
    const data = (await response.json()) as { access_token?: string; expires_in?: number; errmsg?: string };
    if (!response.ok || !data.access_token) {
      throw new Error(`WeChat token request failed: ${data.errmsg ?? response.status}`);
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
      const response = await fetch(
        `${config.wechat.apiBase}/cgi-bin/message/custom/send?access_token=${encodeURIComponent(token)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            touser: toUser,
            msgtype: "text",
            text: { content }
          })
        }
      );
      const data = (await response.json()) as { errcode?: number; errmsg?: string };
      if (!response.ok || (data.errcode && data.errcode !== 0)) {
        throw new Error(`WeChat send failed: ${data.errmsg ?? response.status}`);
      }
    }
  }
}
