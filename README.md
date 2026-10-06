<div align="center">

# Courier

**AI IDE 被锁在桌面上。Courier 把它接到你的聊天软件里。**

通过 Telegram、企业微信、微信公众号、QQ、Discord、邮件或 HTTP 客户端，远程控制本机的 Cursor、Windsurf、VS Code。
开源的本地 IDE 桥接服务，带自愈诊断。

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

</div>

---


## 为什么用 Courier？

- **随时随地干活** — 从 Telegram、企业微信、微信公众号、QQ、Discord，或 CI 里的 cURL，把任务发给本机 Cursor / Windsurf / VS Code。不需要 VNC、RDP、投屏。
- **多 IDE、多平台** — 一套桥接对应一个 IDE。可以并行跑多套实例，各自独立 bot。Discord、飞书、企业微信、微信、QQ、邮件、HTTP API 可以同时开。
- **自愈诊断** — IDE 更新改掉 CSS 选择器时，Courier 启动时会探测，从当前 DOM 里找出候选，并通过已启用的 IM 发来可执行的修复说明。
- **安全优先，代码可审计** — 入站拦截提示词外泄；出站回复会脱敏 token、密钥和机密。整套护栏开源，每一行都能看。

---

## 架构

```
┌───────────────────────────────────────────────────────────┐
│                      平台适配器                             │
│  Telegram · 企业微信 · 微信 · QQ · Discord · HTTP · 飞书 · 邮件 │
└──────────────────────────┬────────────────────────────────┘
                           │
                    ┌──────▼────────┐
                    │ CommandRouter │  ← 解析命令、管理状态
                    └──────┬────────┘
                           │
                    ┌──────▼────────┐
                    │ BridgeService │  ← 编排 IDE 操作
                    └──────┬────────┘
                           │
               ┌───────────┬────────────┐
               │           │            │
        ┌──────▼──────┐    │     ┌──────▼───────┐
        │ CDP 后端    │    │     │  API 后端    │
        │  （默认）    │    │     │ （仅 Cursor） │
        └──────┬──────┘    │     └──────┬───────┘
               │           │            │
      ┌────────▼───────────▼─────────┐  │
      │ Cursor / Windsurf / VS Code  │  │
      │          CDP 客户端           │  │
      └────────┬──────────┬──────────┘  │
               │          │             │
          Cursor IDE   Windsurf IDE  Cursor API
          (CDP :9222)  (CDP :9223)      后端
                        VS Code IDE
                        (CDP :9224)
```

Courier 通过 **Chrome DevTools Protocol**（就是 Chrome DevTools 用的那套协议）连接 IDE。Cursor、Windsurf、VS Code 用 `--remote-debugging-port` 启动后，Courier 会按 best-effort 去操作聊天面板。

Cursor 的回复**不是**走官方 Agent SDK，也不是读内部 SQLite。默认路径是 CDP 抓 Composer 会话 DOM：`assistant-markdown` 是正文，`activity-group` / `tool-placeholder` 是过程，`tail-status:current` 表示还在生成，`turn-actions` 出现后视为本轮结束。结论文本和过程中的第一句话用同一套 class，必须等整轮完成再定稿。

---

## 功能

> **预览版（`v0.x`）**
> - Telegram 的界面最完整（行内按钮、图片/文件附件）。企业微信 / 微信公众号 / QQ 走同一套文本命令（`/help`、`/mode`、`/choose`、直接发任务）。共享命令回复为中文。
> - IDE 必须带 `--remote-debugging-port` 启动，桥接才能连上。
> - 远程桌面仍应作为兜底：IDE 状态、提问、计划不一定总能被检测到。
> - Cursor 选择器已对准 `.tiptap.ProseMirror` 输入框和助手 Markdown 回复；只有本地构建不一致时才改 `.env`。
> - 发给 Cursor 的长任务会等到本轮 `turn-actions` 出现（默认最长 `CURSOR_RELAY_MAX_MS=1h`），再把这一轮全部 `assistant-markdown` 拼起来回 IM，而不是只截第一句。
> - QQ 私聊会把这段正文刷进**同一条官方流式消息**（Markdown 子集）；群聊没有流式接口，终稿单独发 Markdown。
> - Cursor 与 Windsurf 的 `/start` 快捷操作：新对话 | 上一条 · Ask 模式 | Code 模式 · Plan 模式 | Context % · 重启 · 帮助。
> - VS Code 的 `/model`、`/models` 会从当前可见的模型控件做 best-effort 探测/列表；结果取决于本机聊天 UI 状态。
> - `/restart` 会按平台启动脚本重启桥接；起来后会通知「Bridge restarted and is now online.」
> - Context 输出尽量精简：`Context status` / `• Context 20%`（不含路径和备注）。
> - 支持标注遵循约定：`official`、`best-effort`、`unsupported-contract`。

### IDE 控制

| 功能 | Cursor | Windsurf | VS Code |
|---|---|---|---|
| 提示词转发 + 捕获整轮回复 | best-effort | best-effort | best-effort |
| 模式切换 | official（`ask/code/plan/debug`） | official（`ask/code/plan`，无 `debug`） | best-effort（`ask/code/plan`，无 `debug`） |
| 模型探测 + 切换 | best-effort | best-effort | best-effort（从 DOM 探测/列出/切换，失败会明确标 unverified） |
| 新对话 / 会话管理 | official + best-effort | official + best-effort | best-effort（失败会明确标 unverified） |
| 图片与文件附件 | official + best-effort | official + best-effort | official + best-effort |
| 目标/标签页选择 | best-effort | best-effort | best-effort |
| Context 用量提取 | best-effort | best-effort | best-effort |
| API 后端（不需要 CDP） | official（仅 Cursor） | unavailable | unavailable |

### 平台适配器

| 适配器 | 能力 |
|---|---|
| **Telegram（主界面）** | 完整命令、行内按钮/快捷操作、图片/文件附件、重启通知、自动提问提醒（不一定可靠） |
| **企业微信** | 官方回调 + 应用消息接口。文本命令、`/choose`、白名单、启动告警。图片请用 `/attach` 本地路径。个人微信可通过「微信插件」给该应用发消息。 |
| **微信公众号** | 官方回调 + 客服消息。文本命令。用户需先给公众号发过消息（48 小时窗口）。 |
| **QQ 机器人** | 默认官方 WebSocket（本机出站，不需要公网）。也可改 Webhook。单聊流式刷新 Cursor 正文（Markdown 子集）；群聊发 Markdown 终稿。私聊/群聊图片会下载后注入 Cursor（先发图再发文字，或图文一起发）。`/whoami` 取 openid。`/choose`、`/target`。 |
| **Discord** | 仅文本回复（无按钮、无重启通知、附件有限） |
| **HTTP API** | OpenAI 兼容的 `POST /v1/chat/completions`（best-effort） |
| **飞书 / Lark** | 仅文本命令（无按钮/附件） |
| **邮件** | 取正文第一行作为命令（无按钮/附件） |

### 自愈与诊断

| 功能 | 说明 |
|---|---|
| CDP 预检 | 每次启动检查连通性和选择器健康（有时会误报，实际仍可用） |
| 自动发现 | 扫描当前 DOM，给出带置信分的替换选择器候选 |
| 启动告警 | 通过已启用的 IM（Telegram / 企业微信 / 微信 / QQ）发送 IDE 版本、原因和修复建议 |
| `/diag` | 按需完整诊断：选择器命中数与候选 |
| 非阻塞 | 桥接总会启动 — 预检问题只是警告，不会拦住服务 |

### 安全护栏

| 层 | 保护 |
|---|---|
| **入站** | 拦截提示词外泄（cookie、token、环境变量转储、密钥） |
| **出站** | 脱敏 JWT、`sk-`/`ghp_` 等密钥前缀、Bearer token、cookie 和赋值形式的机密；窗口标题、普通路径不会被当成 token |
| **访问** | 按平台白名单（Telegram ID、Discord ID、邮件发件人、飞书 open ID、企业微信 UserId、微信/QQ openid） |
| **网络** | 只在本地跑 — 无云端、无遥测、不回传 |

---

## 快速开始

### 1. 创建 Telegram 机器人（可选）

在 Telegram 给 [@BotFather](https://t.me/BotFather) 发 `/newbot`，复制 token。

只用企业微信 / 微信公众号 / QQ 时，可以跳过这一步，把 `TELEGRAM_BOT_TOKEN` 留空，见 [国内 IM 接入](#国内-im-接入企业微信--微信--qq)。

### 2. 配置

```bash
cp .env.cursor.example .env
```

Windsurf / VS Code 分别用 `.env.windsurf.example`、`.env.vscode.example`。

在 `.env` 里至少填这些（走 Telegram 时）：

```env
TELEGRAM_BOT_TOKEN=your-bot-token
BRIDGE_IDE_TARGET=cursor          # "cursor"、"windsurf" 或 "vscode"
TELEGRAM_ALLOWED_USER_IDS=12345   # 你的 Telegram 用户 ID
```

### 3. 用远程调试启动 IDE

当前 IDE 聊天窗口里不一定看得到已有会话，但新提示词和后续跟进仍然有效。

```powershell
# Cursor
"%LOCALAPPDATA%\Program Files\Cursor\Cursor.exe" --remote-debugging-port=9222

# Windsurf
"%LOCALAPPDATA%\Programs\Windsurf\Windsurf.exe" --remote-debugging-port=9223

# VS Code
"%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe" --remote-debugging-port=9224
```

### 4. 启动 Courier

```bash
npm install
npm run dev
```

打开机器人，发送 `/help` 即可。

健康检查：[http://localhost:8787/health](http://localhost:8787/health)

### 5. Windows 开机（登录后）自动启动

Courier 需要当前用户桌面会话（要连本机 Cursor 的 CDP），所以用「登录时」计划任务，而不是 Windows 服务。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/windows/install-autostart.ps1
```

之后每次登录会后台拉起 Courier。若 8787 已经在听则跳过，避免重复实例。日志在 `tmp/courier-autostart.log`。卸载：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/windows/uninstall-autostart.ps1
```

Cursor 仍需用 `--remote-debugging-port=9222` 打开（例如桌面上的「Cursor 调试」快捷方式），否则 QQ 能连上 Courier，但没法注入对话。

---

## 国内 IM 接入（企业微信 / 微信 / QQ）

这些适配器只走**官方 API**。企业微信和微信公众号的回调需要一条指向本机的公网 URL（cpolar / ngrok / frp / 反向代理）。**QQ 默认走 WebSocket，不需要公网。**

### 企业微信（推荐）

1. 企业微信管理后台 → 应用管理 → 自建 → 创建应用，记下 `AgentId` 和 `Secret`。
2. 应用 → 接收消息 → 设置 API 接收：
   - URL：`https://<公网域名>/platform/wecom/callback`
   - Token / EncodingAESKey：与 `.env` 里的 `WECOM_TOKEN` / `WECOM_AES_KEY` 一致。
3. 打开适配器：

```env
WECOM_ENABLED=true
WECOM_CORP_ID=wwxxxxxxxx
WECOM_AGENT_ID=1000002
WECOM_SECRET=...
WECOM_TOKEN=...
WECOM_AES_KEY=...                 # 43 位
WECOM_ALLOWED_USER_IDS=zhangsan   # 企业微信 UserId 白名单
```

给应用发 `/help`。开启 **微信插件** 后，个人微信也可以给同一个企业应用发消息。

### 微信公众号

1. 公众号后台 → 设置与开发 → 基本配置 → 服务器配置。
2. URL：`https://<公网域名>/platform/wechat/callback`
3. 打开适配器：

```env
WECHAT_ENABLED=true
WECHAT_APP_ID=wx...
WECHAT_APP_SECRET=...
WECHAT_TOKEN=...
WECHAT_AES_KEY=...                # 可选；安全模式/兼容模式加密时必填
WECHAT_ALLOWED_OPEN_IDS=oXXXX     # 留空则允许所有关注者
```

回复走客服消息接口，因此用户必须在 48 小时内先给公众号发过消息。

### QQ 官方机器人

默认走 **WebSocket 长连接**：电脑能访问外网即可，Courier 主动连 QQ 网关收消息，**不需要公网 IP、域名或反代**。

1. 在 [QQ 开放平台](https://q.qq.com) 创建机器人，拿到 AppID / AppSecret。
2. 开发设置里把事件接收方式选成 **WebSocket**（不要填 Webhook 回调地址，两者通常互斥）。
3. 打开单聊 / 群聊相关事件权限（`GROUP_AND_C2C_EVENT`）。
4. 配置：

```env
QQ_ENABLED=true
QQ_EVENT_MODE=websocket          # 默认。需要公网回调时改成 webhook 或 both
QQ_APP_ID=...
QQ_APP_SECRET=...
QQ_ALLOWED_OPEN_IDS=...           # 单聊用户 openid 白名单
QQ_ALLOWED_GROUP_OPEN_IDS=...     # 可选，群 openid 白名单
```

只有在你已经有公网 HTTPS 时，才用 Webhook：`QQ_EVENT_MODE=webhook`，回调 `https://<公网域名>/platform/qq/events`（端口限 80/443/8080/8443）。

**怎么拿到 openid：** QQ 后台不会显示这个值，也不是 QQ 号。用你的 QQ 私聊机器人，发送 `/whoami`（`/id`、`/openid` 也可以）。机器人会把 `user_openid` 回给你，抄进 `QQ_ALLOWED_OPEN_IDS` 后重启。Courier 日志里同样会打出 `userOpenId`。群里发 `/whoami` 得到的是 `group_openid`（给 `QQ_ALLOWED_GROUP_OPEN_IDS`），和单聊 openid 不是同一个。

### QQ 如何回传 Cursor 输出

1. 私聊发普通任务（不以 `/` 开头，或 `/resume`、`/choose`）后，Courier 注入当前固定的 Cursor 窗口。
2. CDP 轮询 Composer 行：过程行（思考 / Exploring / 工具）只用来判断还在跑；正文取本轮所有 `assistant-markdown`。
3. 看到 `tail-status:current` 或工具 `data-tool-status="loading"` 就继续等；`turn-actions`（Copy / Retry / Just now）出现后视为结束。
4. **单聊**调用 `POST /v2/users/{openid}/stream_messages`，用 `replace` 把不断变长的正文写进同一条消息，结束时 `input_state=10`。优先 Markdown，失败则退回纯文本，再失败则拆成普通消息。
5. **群聊**官方不支持流式参数，过程仍是短文本，终稿发 `msg_type=2` Markdown。

QQ Markdown 是子集（标题、加粗、列表、代码块、链接），对不上 Cursor 工作台的语法高亮、diff、工具卡片、思考折叠。单条流式消息大约 4000 字，超出部分会另发一条。

开了两个 Cursor 窗口时，它们通常是**同一个进程的两个页面**（CDP 端口相同）。`/targets` 只列出窗口标题；用 `/target 2` 固定当前工程，避免消息进错窗口。真正并行两套 IDE 需要两份 `--user-data-dir`、两个调试端口、两套 Courier。

---

## 命令

### 核心

| 命令 | 说明 | 示例 |
|---|---|---|
| `/newchat` | 开一个新的 IDE 对话 | `/newchat` |
| `/mode <mode>` | 切换模式：`ask`、`code`、`plan`、`debug` | `/mode code` |
| `/model [name]` | 探测当前模型，或按模糊匹配切换（不带参数则读当前标签） | `/model claude sonnet` |
| `/last` | 取最新一条助手回复 | `/last` |
| `/resume [text]` | 继续上一件事 | `/resume fix the tests` |
| `/choose <option>` | 回答助手提问 | `/choose A` |
| `/diag` | 完整 CDP + 选择器诊断 | `/diag` |
| `/restart` | 重启桥接（走对应平台启动脚本） | `/restart` |

### 状态与会话

| 命令 | 说明 |
|---|---|
| `/context` | Context 窗口用量 |
| `/usage` | 用量/账单状态 |
| `/progress` | 当前请求状态 + 已用时间 |
| `/targets` 或 `/chats` | 列出可用 IDE 窗口（只显示标题，不含 URL） |
| `/target <n>` 或 `/target auto` | 固定第 n 个窗口，或改回自动选择 |
| `/whoami` | QQ 场景下查看 `user_openid` / 群 `group_openid` |
| `/history [n\|clear]` | 最近回复，或清空历史 |
| `/cancel [all]` | 停止后续轮询 |

### 附件（Telegram）

| 命令 | 说明 |
|---|---|
| 发送图片 | 附加到 IDE 输入框（先发图，再发提示词） |
| 发送文件 | 附加到 IDE 输入框（先发文件，再发提示词） |
| `/attach <path>` | 按绝对路径注入本机文件 |
| `/attach <path> \| prompt` | 附加并自动提交提示词 |
| `/photomode auto\|manual` | 切换附件是否自动提交 |
| `/queue` | 查看待处理附件队列 |
| `/clearqueue` | 清空附件队列 |

> **提示：** 发图片时先发图，等送达后再打提示词。文件同样。

### 选择题（问题路由）

助手提问时，Courier 会尽量发一条带快捷选项的提醒（不一定可靠，可能误报，重要操作请用远程桌面核对）：

```
/choose A                         # 选 A
/choose D your custom answer      # 自定义回答
/choose multi A,C                 # 多选
/choose multi A,C,D:custom text   # 多选 + 自定义
```

---

## 支持的 IDE

### 最近一次本机预检

- Cursor 预检：PASS（最近一次本机运行）
- Windsurf 预检：PASS（最近一次本机运行）
- VS Code 预检：PASS（最近一次本机运行）
- 命令：按 IDE 设置 `BRIDGE_IDE_TARGET` 后执行 `npx tsx scripts/cdp-preflight.ts`

### 模式映射

| Courier 模式 | Cursor | Windsurf | VS Code |
|---|---|---|---|
| `ask` | official（`Ask`） | official（`Chat`） | best-effort（`Ask`） |
| `code` | official（`Agent`） | official（`Write`） | best-effort（`Agent`） |
| `plan` | official（`Plan`） | official（`Plan`） | best-effort（`Plan`） |
| `debug` | official（`Debug`） | unavailable | unavailable |

### 模型切换

- **Cursor（`best-effort`）**：按 CSS 选择器找下拉框（`[class*="composer-unified-dropdown-model"]` 及回退）
- **Windsurf（`best-effort`）**：在 Cascade 面板附近按关键词扫按钮
- **VS Code（`best-effort`）**：读当前模型标签，打开选择器，列出可见选项，尽量模糊匹配
- 模糊匹配顺序：精确 > 包含 > 部分词
- 示例：`/model claude sonnet`、`/model gpt-4o`、`/model auto`
- 目标模型在当前选择器里不可见时，会返回明确的 `model-not-found` / `unverified`，不会假装成功

---

## 自愈告警

IDE 更新改了 DOM 结构时，Courier 会马上抓住：
（告警有时是误报，发一条斜杠命令即可核对）

```
⚠️ Bridge Alert (Cursor v0.48.7): Selector CHAT_INPUT failed (no matches).
Likely Cause: Cursor v0.48.7 update changed the Composer layout.
Auto-Discovered: "div[role="textbox"]" (class="new-composer-input", score=350)
Quick Fix: Update CURSOR_CHAT_INPUT_SELECTOR in .env, or run /diag to see all candidates.

Run /diag anytime for a full diagnostic with auto-discovered selector candidates.
```

**告警类型：**

- **CDP 不可达** — 启动命令 + 端口冲突提示
- **没有页面目标** — 提示先打开文件夹和面板
- **选择器失效** — IDE 版本、自动发现的最佳候选（class/分数）、对应的 `.env` 变量名
- **非法 CSS** — 语法错误提示
- **模式指示缺失** — 面板可能被收起

---

## HTTP 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/health` | 桥接健康状态 + 后端模式 + 已启用适配器 |
| `POST` | `/v1/chat/completions` | OpenAI 兼容的聊天补全 |
| `POST` | `/platform/feishu/events` | 飞书事件入口 |
| `GET/POST` | `/platform/wecom/callback` | 企业微信 URL 验证 + 消息回调 |
| `GET/POST` | `/platform/wechat/callback` | 微信公众号回调 |
| `POST` | `/platform/qq/events` | QQ 机器人 Webhook |

HTTP API 接收标准 OpenAI chat 请求体，返回兼容的 completion。可用 `BRIDGE_API_AUTH_TOKEN` 做可选 Bearer 鉴权。

---

## 进阶配置

### 多 IDE（并行实例）

用两套配置和两个 bot 跑两个桥接：

```powershell
# 终端 1 — Cursor
$env:DOTENV_CONFIG_PATH=".env.cursor"; npx tsx src/index.ts

# 终端 2 — Windsurf
$env:DOTENV_CONFIG_PATH=".env.windsurf"; npx tsx src/index.ts
```

每个实例需要自己的 bot token（或企业微信/微信/QQ 凭证）、`PORT` 和 `BRIDGE_IDE_TARGET`。Telegram 请在 @BotFather 各建一个机器人。

### CDP 与 API 后端

| | CDP（默认） | API |
|---|---|---|
| 需要 IDE 带 `--remote-debugging-port` | ✅ | — |
| 需要 API 凭证 | — | ✅（仅 Cursor） |
| 模式/模型切换 | ✅ | — |
| 图片/文件附件 | ✅ | — |
| 目标选择 | ✅ | — |
| 提示词转发 | ✅ | ✅ |

在 `.env` 里设 `BRIDGE_BACKEND_MODE=api` 可走 API 模式（仅 Cursor）。

---

<details>
<summary><strong>配置参考</strong></summary>

### 必填

至少配置一种入站适配器。Telegram 不再强制。

| 变量 | 说明 |
|---|---|
| `TELEGRAM_BOT_TOKEN` | 可选。来自 @BotFather 的 Telegram bot token。留空则只跑企业微信/微信/QQ/HTTP。 |

### 通用

| 变量 | 默认值 | 说明 |
|---|---|---|
| `NODE_ENV` | `development` | 运行环境 |
| `LOG_LEVEL` | `info` | Pino 日志级别 |
| `PORT` | `8787` | HTTP 服务端口 |
| `BRIDGE_IDE_TARGET` | `cursor` | `cursor`、`windsurf` 或 `vscode` |
| `BRIDGE_BACKEND_MODE` | `cdp` | `cdp` 或 `api` |
| `BRIDGE_API_AUTH_TOKEN` | — | HTTP API 可选 Bearer token |
| `TELEGRAM_ALLOWED_USER_IDS` | — | 逗号分隔白名单 |
| `TELEGRAM_REQUEST_TIMEOUT_MS` | `30000` | 转发超时 |

### Cursor

| 变量 | 默认值 | 说明 |
|---|---|---|
| `CURSOR_REMOTE_DEBUG_URL` | `http://127.0.0.1:9222` | CDP 地址 |
| `CURSOR_TARGET_TITLE_HINT` | `Cursor` | 窗口标题过滤 |
| `CURSOR_CHAT_INPUT_SELECTOR` | （内置） | 聊天输入框 CSS 选择器覆盖 |
| `CURSOR_RESPONSE_SELECTOR` | （内置） | 回复容器 CSS 选择器覆盖 |
| `CURSOR_CONTEXT_SELECTOR` | （内置） | Context 指示器 CSS 选择器覆盖 |
| `CURSOR_MODEL_SELECTOR` | `[class*="composer-unified-dropdown-model"]` | 模型下拉 CSS 选择器 |
| `CURSOR_ACTION_TIMEOUT_MS` | `30000` | 短操作超时（聚焦、注入、无进度回调时的抓取） |
| `CURSOR_RELAY_MAX_MS` | `3600000` | 带进度回调时等待 Cursor 整轮结束的上限（默认 1 小时） |
| `CURSOR_SQLITE_PATH` | （自动探测） | 状态数据库路径 |
| `CURSOR_APP_EXE` | `Cursor` | 可执行文件提示 |
| `CURSOR_CONTEXT_REGION` | — | OCR 裁剪区域：`x,y,width,height` |
| `CURSOR_CONTEXT_HOVER_POINT` | — | 悬停点：`x,y` |

### Windsurf

| 变量 | 默认值 | 说明 |
|---|---|---|
| `WINDSURF_REMOTE_DEBUG_URL` | `http://127.0.0.1:9223` | CDP 地址 |
| `WINDSURF_TARGET_TITLE_HINT` | `Windsurf` | 窗口标题过滤 |
| `WINDSURF_CHAT_INPUT_SELECTOR` | （内置） | 聊天输入框 CSS 选择器覆盖 |
| `WINDSURF_RESPONSE_SELECTOR` | （内置） | 回复容器 CSS 选择器覆盖 |
| `WINDSURF_MODE_SELECTOR` | （内置） | 模式切换 CSS 选择器覆盖 |
| `WINDSURF_CONTEXT_SELECTOR` | （内置） | Context 指示器 CSS 选择器覆盖 |
| `WINDSURF_MODEL_SELECTOR` | （自动探测） | 模型按钮关键词扫描覆盖 |
| `WINDSURF_ACTION_TIMEOUT_MS` | `30000` | 操作超时 |
| `WINDSURF_SQLITE_PATH` | （自动探测） | 状态数据库路径 |

### VS Code

| 变量 | 默认值 | 说明 |
|---|---|---|
| `VSCODE_REMOTE_DEBUG_URL` | `http://127.0.0.1:9224` | CDP 地址 |
| `VSCODE_TARGET_TITLE_HINT` | `Code` | 窗口标题过滤 |
| `VSCODE_CHAT_INPUT_SELECTOR` | （内置） | 聊天输入框 CSS 选择器覆盖 |
| `VSCODE_RESPONSE_SELECTOR` | （内置） | 回复容器 CSS 选择器覆盖 |
| `VSCODE_MODE_SELECTOR` | — | 可选模式选择器覆盖 |
| `VSCODE_MODEL_SELECTOR` | — | 可选模型标签/选择器覆盖 |
| `VSCODE_CONTEXT_SELECTOR` | — | 可选 Context 选择器覆盖 |
| `VSCODE_ACTION_TIMEOUT_MS` | `30000` | 操作超时 |
| `VSCODE_SQLITE_PATH` | （自动探测） | 状态数据库路径 |

### Cursor API 后端

| 变量 | 默认值 | 说明 |
|---|---|---|
| `CURSOR_API_KEY` | — | API key（API 模式必填） |
| `CURSOR_API_BASE_URL` | `https://api.cursor.com` | API 根地址 |
| `CURSOR_API_REPOSITORY` | — | 仓库（API 模式必填） |
| `CURSOR_API_MODEL` | — | 模型覆盖 |
| `CURSOR_API_REF` | — | Git ref |
| `CURSOR_API_TIMEOUT_MS` | `30000` | API 超时 |

### Discord

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DISCORD_ENABLED` | `false` | 启用 Discord 适配器 |
| `DISCORD_BOT_TOKEN` | — | Discord bot token |
| `DISCORD_ALLOWED_USER_IDS` | — | 逗号分隔白名单 |

### 邮件

| 变量 | 默认值 | 说明 |
|---|---|---|
| `EMAIL_ENABLED` | `false` | 启用邮件适配器 |
| `EMAIL_ALLOWED_FROM` | — | 发件人白名单（空则允许全部） |
| `EMAIL_IMAP_HOST` | — | IMAP 主机 |
| `EMAIL_IMAP_PORT` | — | IMAP 端口 |
| `EMAIL_IMAP_SECURE` | — | IMAP TLS |
| `EMAIL_IMAP_USER` | — | IMAP 用户名 |
| `EMAIL_IMAP_PASS` | — | IMAP 密码 |
| `EMAIL_SMTP_HOST` | — | SMTP 主机 |
| `EMAIL_SMTP_PORT` | — | SMTP 端口 |
| `EMAIL_SMTP_SECURE` | — | SMTP TLS |
| `EMAIL_SMTP_USER` | — | SMTP 用户名 |
| `EMAIL_SMTP_PASS` | — | SMTP 密码 |
| `EMAIL_POLL_INTERVAL_MS` | `30000` | IMAP 轮询间隔 |

### 飞书 / Lark

| 变量 | 默认值 | 说明 |
|---|---|---|
| `FEISHU_ENABLED` | `false` | 启用飞书适配器 |
| `FEISHU_APP_ID` | — | 应用 App ID |
| `FEISHU_APP_SECRET` | — | 应用 Secret |
| `FEISHU_VERIFICATION_TOKEN` | — | 事件校验 Token |
| `FEISHU_ENCRYPT_KEY` | — | 签名校验 Key |
| `FEISHU_ALLOWED_OPEN_IDS` | — | 逗号分隔白名单 |

### 企业微信

| 变量 | 默认值 | 说明 |
|---|---|---|
| `WECOM_ENABLED` | `false` | 启用企业微信适配器 |
| `WECOM_CORP_ID` | — | 企业 ID |
| `WECOM_AGENT_ID` | `0` | 自建应用 AgentId |
| `WECOM_SECRET` | — | 应用 Secret |
| `WECOM_TOKEN` | — | 回调 Token |
| `WECOM_AES_KEY` | — | 43 位 EncodingAESKey |
| `WECOM_ALLOWED_USER_IDS` | — | 企业微信 UserId 白名单（空则允许全部） |
| `WECOM_API_BASE` | `https://qyapi.weixin.qq.com` | API 根地址 |

### 微信公众号

| 变量 | 默认值 | 说明 |
|---|---|---|
| `WECHAT_ENABLED` | `false` | 启用公众号适配器 |
| `WECHAT_APP_ID` | — | App ID |
| `WECHAT_APP_SECRET` | — | App Secret |
| `WECHAT_TOKEN` | — | 回调 Token |
| `WECHAT_AES_KEY` | — | 加密模式可选 EncodingAESKey |
| `WECHAT_ALLOWED_OPEN_IDS` | — | OpenID 白名单（空则允许全部） |
| `WECHAT_API_BASE` | `https://api.weixin.qq.com` | API 根地址 |

### QQ 机器人

| 变量 | 默认值 | 说明 |
|---|---|---|
| `QQ_ENABLED` | `false` | 启用 QQ 官方机器人适配器 |
| `QQ_APP_ID` | — | 机器人 AppID |
| `QQ_APP_SECRET` | — | 机器人 AppSecret（Webhook Ed25519 也用它） |
| `QQ_ALLOWED_OPEN_IDS` | — | 单聊 openid 白名单（空则允许全部） |
| `QQ_ALLOWED_GROUP_OPEN_IDS` | — | 群 openid 白名单（空则允许全部群） |
| `QQ_API_BASE` | `https://api.bot.qq.com` | OpenAPI 根地址 |
| `QQ_EVENT_MODE` | `websocket` | `websocket` 本机出站无需公网；`webhook` 需公网回调；`both` 两种都开 |

单聊任务默认走官方流式消息刷新 Cursor 正文，无需额外开关。群聊仍为普通 Markdown 终稿。

</details>

---

## 脚本

| 脚本 | 说明 |
|---|---|
| `npm run dev` | 用 `tsx` 从源码热重载运行 |
| `npm run build` | 编译 TypeScript 到 `dist/` |
| `npm run start` | 运行编译产物 |
| `npm run lint` | ESLint 检查 |
| `npm run typecheck` | TypeScript 类型检查（不产出文件） |
| `npm run verify` | lint + typecheck + build |
| `npm run test:smoke` | 快速冒烟：护栏 + 本地会话状态持久化 |
| `npm run scan:secrets` | 扫描已跟踪文件中的高风险密钥/PII 模式 |
| `npm run verify:release` | 发布门禁：verify + smoke + secret scan |
| `scripts/windows/install-autostart.ps1` | 注册 Windows 登录后自动启动 Courier |
| `scripts/windows/uninstall-autostart.ps1` | 移除该计划任务 |

**诊断：**

- `npx tsx scripts/cdp-preflight.ts` — CDP 连通性 + 选择器健康检查
- `npm run scan:secrets` — 已跟踪文件里出现 token/密钥/PII 特征则失败

---

## 贡献

欢迎贡献。指南见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

本项目使用 [MIT License](LICENSE)。

Copyright (c) 2026 Grasp Visual LLC. Created by Alan Perez.

---

<div align="center">

**Built by Grasp Visual LLC · Created by Alan Perez**

</div>
