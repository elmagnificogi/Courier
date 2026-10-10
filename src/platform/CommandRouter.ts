import { BridgeService } from "../bridge/BridgeService";
import { BridgeMode, SendPromptOptions } from "../types";
import { ChatStateStore } from "../telegram/ChatStateStore";
import { TextSecurityGuard } from "../security/TextSecurityGuard";
import { config, IdeTarget, ideDisplayName, ideSupportsDebugMode } from "../config";
import { buildMultiChoiceRelayPrompt, buildSingleChoiceRelayPrompt, chooseUsageText } from "./choosePrompt";

interface ProgressState {
  requestId: number;
  phase: string;
  startedAt: number;
  updatedAt: number;
}

export class CommandRouter {
  private readonly bridge = new BridgeService();
  private readonly stateStore = new ChatStateStore();
  private readonly lastPromptByChannel = new Map<string, { prompt: string; at: number }>();
  private readonly activeRequestByChannel = new Map<string, number>();
  private readonly progressByChannel = new Map<string, ProgressState>();
  private readonly pendingAttachmentByChannel = new Map<
    string,
    { kind: "photo" | "document"; createdAt: number; fileName?: string }
  >();
  private readonly ideByChannel = new Map<string, IdeTarget>();
  private nextRequestId = 1;

  async attachPhoto(
    channelId: string,
    filePath: string,
    options?: { prompt?: string; fileName?: string; mimeType?: string } & SendPromptOptions
  ): Promise<string> {
    return await this.attachMedia(channelId, filePath, "photo", options);
  }

  async attachMedia(
    channelId: string,
    filePath: string,
    kind: "photo" | "document",
    options?: { prompt?: string; fileName?: string; mimeType?: string } & SendPromptOptions
  ): Promise<string> {
    const prompt = String(options?.prompt ?? "").trim();
    const injectOptions: { autoSubmit: false; fileName?: string; mimeType?: string } = { autoSubmit: false };
    if (options?.fileName) {
      injectOptions.fileName = options.fileName;
    }
    if (options?.mimeType) {
      injectOptions.mimeType = options.mimeType;
    }
    const ide = this.ideFor(channelId);
    const status =
      kind === "photo"
        ? await this.bridge.injectPhoto(filePath, injectOptions, ide)
        : await this.bridge.injectDocument(filePath, injectOptions, ide);
    if (/failed|无法注入|失败/i.test(status)) {
      return status;
    }
    const pending: { kind: "photo" | "document"; createdAt: number; fileName?: string } = {
      kind,
      createdAt: Date.now()
    };
    if (options?.fileName) {
      pending.fileName = options.fileName;
    }
    this.pendingAttachmentByChannel.set(channelId, pending);
    const ideName = ideDisplayName(ide);
    if (!prompt) {
      return kind === "photo"
        ? `图已放进 ${ideName} 输入框。下一条文字会连这张图一起发出去。`
        : `文件已放进 ${ideName} 输入框。下一条文字会连这个文件一起发出去。`;
    }
    return await this.relayPrompt(channelId, prompt, options);
  }

  async handle(channelId: string, text: string, options?: SendPromptOptions): Promise<string> {
    const value = text.trim();
    if (!value) {
      return "消息为空。";
    }

    if (value === "/help" || value === "/start") {
      return this.helpText(channelId);
    }
    if (value === "/models") {
      return TextSecurityGuard.sanitizeOutbound(await this.bridge.listModels(this.ideFor(channelId)));
    }
    if (value.startsWith("/model")) {
      const modelArg = value.replace("/model", "").trim();
      const ide = this.ideFor(channelId);
      if (!modelArg) {
        return TextSecurityGuard.sanitizeOutbound(await this.bridge.getModel(ide));
      }
      return TextSecurityGuard.sanitizeOutbound(await this.bridge.setModel(modelArg, ide));
    }
    if (value.startsWith("/mode")) {
      const mode = value.replace("/mode", "").trim().toLowerCase() as BridgeMode;
      const ide = this.ideFor(channelId);
      const validModes = ideSupportsDebugMode(ide) ? ["ask", "code", "plan", "debug"] : ["ask", "code", "plan"];
      if (!validModes.includes(mode)) {
        return `模式无效。请使用：/mode ${validModes.join("|")}`;
      }
      return TextSecurityGuard.sanitizeOutbound(await this.bridge.switchMode(mode, ide));
    }
    if (value === "/newchat") {
      // Allow raw output so diagnostic fields (e.g., new chat candidates) are visible to the user
      return await this.bridge.newChat(this.ideFor(channelId));
    }
    if (value === "/context") {
      return TextSecurityGuard.sanitizeOutbound(await this.bridge.contextStatus(this.ideFor(channelId)));
    }
    if (value === "/usage") {
      return TextSecurityGuard.sanitizeOutbound(await this.bridge.usageStatus(this.ideFor(channelId)));
    }
    if (value === "/restart") {
      return TextSecurityGuard.sanitizeOutbound(await this.bridge.restart());
    }
    if (value === "/diag") {
      // Allow raw diagnostics output (no redaction) for troubleshooting
      return await this.bridge.diagnostics(this.ideFor(channelId));
    }
    if (value === "/chats" || value === "/targets") {
      return TextSecurityGuard.sanitizeOutbound(await this.bridge.listChats(this.ideFor(channelId)));
    }
    if (value.startsWith("/target")) {
      return await this.handleTarget(channelId, value);
    }
    if (value === "/queue") {
      const pending = this.pendingAttachmentByChannel.get(channelId);
      if (!pending) {
        return "没有待处理附件。";
      }
      const age = Math.max(0, Math.round((Date.now() - pending.createdAt) / 1000));
      return `待处理：${pending.kind}${pending.fileName ? ` ${pending.fileName}` : ""}（${age}秒前）`;
    }
    if (value === "/clearqueue") {
      this.pendingAttachmentByChannel.delete(channelId);
      return "已清空附件队列。";
    }
    if (value === "/progress") {
      return this.progressStatus(channelId);
    }
    if (value.startsWith("/cancel")) {
      const arg = value.replace("/cancel", "").trim().toLowerCase();
      if (arg === "all") {
        return this.cancelAll();
      }
      return this.cancel(channelId);
    }
    if (value === "/last") {
      const latest = await this.bridge.latestResponse(this.ideFor(channelId));
      if (latest) {
        return TextSecurityGuard.sanitizeOutbound(latest);
      }
      const stored = this.stateStore.getLastDelivered(this.channelKeyToNumber(channelId));
      return TextSecurityGuard.sanitizeOutbound(stored?.text ?? "还没有助手回复。");
    }
    if (value.startsWith("/history")) {
      return this.history(channelId, value);
    }
    if (value.startsWith("/resume")) {
      const arg = value.replace("/resume", "").trim();
      if (arg) {
        return await this.relayPrompt(channelId, arg, options);
      }
      const previous = this.lastPromptByChannel.get(channelId)?.prompt
        ?? this.stateStore.getLastPrompt(this.channelKeyToNumber(channelId))?.prompt;
      if (!previous) {
        return "没有找到上一次任务。";
      }
      return await this.relayPrompt(channelId, `继续上一次任务。\n原始请求：${previous}`, options);
    }
    if (value.startsWith("/choose")) {
      return await this.handleChoose(channelId, value, options);
    }

    return TextSecurityGuard.sanitizeOutbound(await this.relayPrompt(channelId, value, options));
  }

  private async handleChoose(channelId: string, text: string, options?: SendPromptOptions): Promise<string> {
    const latest = (await this.bridge.latestResponse(this.ideFor(channelId)))
      ?? this.stateStore.getLastDelivered(this.channelKeyToNumber(channelId))?.text;
    if (!latest) {
      return "当前没有待回答的助手问题。可先发送 /last 查看上一条回复。";
    }
    const raw = text.replace(/^\/choose/i, "").trim();
    if (!raw) {
      return chooseUsageText();
    }
    const lower = raw.toLowerCase();
    const relayPrompt = lower.startsWith("multi ")
      ? buildMultiChoiceRelayPrompt(latest, raw.slice(6).trim())
      : buildSingleChoiceRelayPrompt(latest, raw);
    if (!relayPrompt) {
      return [
        "/choose 格式无效。",
        "",
        "示例：",
        "- `/choose A`",
        "- `/choose D 先用只读模式执行`",
        "- `/choose multi A,B`",
        "- `/choose multi B,D:同时加上日志`"
      ].join("\n");
    }
    return await this.relayPrompt(channelId, relayPrompt, options);
  }

  private async relayPrompt(channelId: string, prompt: string, options?: SendPromptOptions): Promise<string> {
    const policy = TextSecurityGuard.evaluatePrompt(prompt);
    if (!policy.allowed) {
      return policy.reason ?? "已被安全策略拦截。";
    }
    const requestId = this.nextRequestId++;
    const startedAt = Date.now();
    this.lastPromptByChannel.set(channelId, { prompt, at: startedAt });
    this.stateStore.recordPrompt(this.channelKeyToNumber(channelId), prompt, startedAt);
    this.activeRequestByChannel.set(channelId, requestId);
    this.progressByChannel.set(channelId, { requestId, phase: "running", startedAt, updatedAt: startedAt });
    try {
      const relayOptions: SendPromptOptions = {};
      if (options?.onProgress) {
        relayOptions.onProgress = async (event) => {
          this.progressByChannel.set(channelId, {
            requestId,
            phase: event.phase,
            startedAt,
            updatedAt: Date.now()
          });
          await options.onProgress?.(event);
        };
      }
      if (options?.signal) {
        relayOptions.signal = options.signal;
      }
      const pending = this.takePendingAttachment(channelId);
      const ide = this.ideFor(channelId);
      const response = pending
        ? await this.bridge.relayPromptForPendingAttachment(prompt, pending.kind, pending.fileName, relayOptions, ide)
        : await this.bridge.relayPrompt(prompt, relayOptions, ide);
      this.stateStore.recordDelivered(this.channelKeyToNumber(channelId), response, requestId, Date.now());
      this.progressByChannel.delete(channelId);
      this.activeRequestByChannel.delete(channelId);
      return TextSecurityGuard.sanitizeOutbound(response);
    } catch (error) {
      this.progressByChannel.delete(channelId);
      this.activeRequestByChannel.delete(channelId);
      throw error;
    }
  }

  private progressStatus(channelId: string): string {
    const progress = this.progressByChannel.get(channelId);
    if (!progress) {
      return "当前没有进行中的请求。";
    }
    const elapsed = Math.max(0, Math.round((Date.now() - progress.startedAt) / 1000));
    return `请求 #${progress.requestId} 正在${progress.phase === "running" ? "执行" : progress.phase}。已用时：${elapsed}秒。`;
  }

  private cancel(channelId: string): string {
    const requestId = this.activeRequestByChannel.get(channelId);
    if (!requestId) {
      return "没有可取消的请求。";
    }
    this.activeRequestByChannel.delete(channelId);
    this.progressByChannel.delete(channelId);
    return `已取消进行中的请求 #${requestId}。`;
  }

  private cancelAll(): string {
    const count = this.activeRequestByChannel.size;
    this.activeRequestByChannel.clear();
    this.progressByChannel.clear();
    return count > 0 ? `已取消 ${count} 个进行中的请求。` : "没有可取消的请求。";
  }

  private history(channelId: string, text: string): string {
    const arg = text.replace("/history", "").trim().toLowerCase();
    const chatId = this.channelKeyToNumber(channelId);
    if (arg === "clear") {
      const removed = this.stateStore.clearHistory(chatId);
      return removed > 0 ? `已清除 ${removed} 条历史记录。` : "历史记录已经是空的。";
    }
    let limit = Number(arg);
    if (!Number.isFinite(limit) || limit <= 0) {
      limit = 5;
    }
    limit = Math.min(limit, 10);
    const history = this.stateStore.getHistory(chatId, limit);
    if (history.length === 0) {
      return "还没有回复历史。";
    }
    return TextSecurityGuard.sanitizeOutbound(
      history.map((item, idx) => `${idx + 1}. [${new Date(item.at).toISOString()}] ${item.text}`).join("\n")
    );
  }

  ideLabel(channelId: string): string {
    return ideDisplayName(this.ideFor(channelId));
  }

  private ideFor(channelId: string): IdeTarget {
    return this.ideByChannel.get(channelId) ?? config.bridgeIdeTarget;
  }

  private async handleTarget(channelId: string, value: string): Promise<string> {
    const arg = value.replace("/target", "").trim().toLowerCase();
    const current = this.ideFor(channelId);
    if (!arg) {
      return TextSecurityGuard.sanitizeOutbound(await this.bridge.targetStatus(current));
    }
    if (arg === "auto") {
      const result = await this.bridge.selectRoutedTarget("auto", current);
      this.ideByChannel.delete(channelId);
      return TextSecurityGuard.sanitizeOutbound(result.text);
    }
    const index = Number(arg);
    if (!Number.isInteger(index) || index <= 0) {
      return "目标无效。请使用 /target <序号> 或 /target auto。";
    }
    const result = await this.bridge.selectRoutedTarget(index, current);
    if (result.ide) {
      this.ideByChannel.set(channelId, result.ide);
    }
    return TextSecurityGuard.sanitizeOutbound(result.text);
  }

  private channelKeyToNumber(channelId: string): number {
    let hash = 0;
    for (let i = 0; i < channelId.length; i += 1) {
      hash = (hash * 31 + channelId.charCodeAt(i)) >>> 0;
    }
    return hash;
  }

  private helpText(channelId: string): string {
    const ide = this.ideFor(channelId);
    return [
      `Courier 命令（当前 ${ideDisplayName(ide)}）：`,
      ideSupportsDebugMode(ide) ? "/mode ask|code|plan|debug  切换模式" : "/mode ask|code|plan  切换模式",
      "/model [模型名]  查看或切换模型",
      "/newchat  新开 IDE 对话",
      "/context  Context 用量",
      "/usage  用量状态",
      "/progress  当前请求进度",
      "/resume [补充说明]  继续上次任务",
      "/cancel [all]  取消请求",
      "/last  上一条助手回复",
      "/choose A|B|C|D [自定义]  回答助手提问",
      "/history [条数|clear]  历史记录",
      "/chats 或 /targets  列出各 IDE 已打开的窗口",
      "/target <序号>|auto  把当前对话发到这个窗口，或改回自动",
      "/diag  诊断",
      "/whoami  查看 QQ openid，或企业微信智能机器人 userid",
      "/queue  查看待发送的图片或文件",
      "/clearqueue  清掉待发送的附件",
      "企业微信智能机器人、QQ 可以直接发图片或文件，下一条文字会一起进入当前 IDE"
    ].join("\n");
  }

  private takePendingAttachment(
    channelId: string
  ): { kind: "photo" | "document"; createdAt: number; fileName?: string } | undefined {
    const pending = this.pendingAttachmentByChannel.get(channelId);
    if (!pending) {
      return undefined;
    }
    this.pendingAttachmentByChannel.delete(channelId);
    if (Date.now() - pending.createdAt > 15 * 60 * 1000) {
      return undefined;
    }
    return pending;
  }
}

