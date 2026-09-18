import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { config, enabledAdapterNames } from "../config";
import { logger } from "../logger";
import { CommandRouter } from "../platform/CommandRouter";
import { FeishuService } from "../platform/FeishuService";
import { WeComService } from "../platform/WeComService";
import { WeChatService } from "../platform/WeChatService";
import { QQService } from "../platform/QQService";
import { HttpResult } from "../platform/HttpResult";
import { parseQueryPreservingPlus } from "../platform/weixinCrypto";

const router = new CommandRouter();
const feishu = new FeishuService();
const wecom = new WeComService();
const wechat = new WeChatService();
const qq = new QQService();

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function unauthorized(res: ServerResponse): void {
  res.statusCode = 401;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ error: "unauthorized" }));
}

function writeResult(res: ServerResponse, result: HttpResult): void {
  res.statusCode = result.status;
  if (typeof result.body === "string") {
    res.setHeader("content-type", result.contentType ?? "text/plain; charset=utf-8");
    res.end(result.body);
    return;
  }
  res.setHeader("content-type", result.contentType ?? "application/json");
  res.end(JSON.stringify(result.body));
}

function headerMap(req: IncomingMessage): Record<string, string | undefined> {
  const mapped: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") {
      mapped[key.toLowerCase()] = value;
    } else if (Array.isArray(value)) {
      mapped[key.toLowerCase()] = value[0];
    }
  }
  return mapped;
}

export function startHealthServer(): void {
  wecom.start();
  wechat.start();
  qq.start();

  const server = createServer(async (req, res) => {
    const method = req.method || "GET";
    const parsed = new URL(req.url || "/", `http://127.0.0.1:${config.port}`);
    const pathname = parsed.pathname;
    const query = parseQueryPreservingPlus(parsed.search);

    if (method === "GET" && pathname === "/health") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          ok: true,
          service: "courier",
          backend: config.bridgeBackendMode,
          adapters: enabledAdapterNames()
        })
      );
      return;
    }

    if (method === "POST" && pathname === "/v1/chat/completions") {
      if (config.bridgeApiAuthToken) {
        const auth = req.headers.authorization || "";
        if (auth !== `Bearer ${config.bridgeApiAuthToken}`) {
          unauthorized(res);
          return;
        }
      }
      const raw = await readBody(req);
      let body: {
        messages?: Array<{ role?: string; content?: string }>;
        model?: string;
      };
      try {
        body = JSON.parse(raw) as {
          messages?: Array<{ role?: string; content?: string }>;
          model?: string;
        };
      } catch {
        res.statusCode = 400;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "invalid json" }));
        return;
      }
      const message = [...(body.messages ?? [])].reverse().find((item) => item.role === "user" && item.content)?.content;
      if (!message) {
        res.statusCode = 400;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "missing user message" }));
        return;
      }
      const answer = await router.handle("http:default", message);
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          id: `chatcmpl-${Date.now()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: body.model || "courier",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: { role: "assistant", content: answer }
            }
          ]
        })
      );
      return;
    }

    if (method === "POST" && pathname === "/platform/feishu/events") {
      const raw = await readBody(req);
      const headers = headerMap(req);
      const result = await feishu.handleEvents(raw, {
        "x-lark-request-timestamp": headers["x-lark-request-timestamp"],
        "x-lark-request-nonce": headers["x-lark-request-nonce"],
        "x-lark-signature": headers["x-lark-signature"]
      });
      writeResult(res, result);
      return;
    }

    if ((method === "GET" || method === "POST") && pathname === "/platform/wecom/callback") {
      const raw = method === "POST" ? await readBody(req) : "";
      const result = await wecom.handleRequest(method, query, raw);
      writeResult(res, result);
      return;
    }

    if ((method === "GET" || method === "POST") && pathname === "/platform/wechat/callback") {
      const raw = method === "POST" ? await readBody(req) : "";
      const result = await wechat.handleRequest(method, query, raw);
      writeResult(res, result);
      return;
    }

    if (method === "POST" && pathname === "/platform/qq/events") {
      const raw = await readBody(req);
      const result = await qq.handleEvents(raw, headerMap(req));
      writeResult(res, result);
      return;
    }

    res.statusCode = 404;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: "not_found" }));
  });

  server.listen(config.port, () => {
    logger.info({ port: config.port }, "Health/API endpoint started");
  });
}
