import { BridgeService } from "../bridge/BridgeService";
import { BridgeMode, SendPromptOptions } from "../types";
import { ChatStateStore } from "../telegram/ChatStateStore";
import { TextSecurityGuard } from "../security/TextSecurityGuard";
import { config } from "../config";
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
  private nextRequestId = 1;

  async handle(channelId: string, text: string, options?: SendPromptOptions): Promise<string> {
    const value = text.trim();
    if (!value) {
      return "消息为空。";
    }

    if (value === "/help" || value === "/start") {
      return this.helpText();
    }
    if (value === "/models") {
      return TextSecurityGuard.sanitizeOutbound(await this.bridge.listModels());
    }
    if (value.startsWith("/model")) {
      const modelArg = value.replace("/model", "").trim();
      if (!modelArg) {
        return TextSecurityGuard.sanitizeOutbound(await this.bridge.getModel());
      }
      return TextSecurityGuard.sanitizeOutbound(await this.bridge.setModel(modelArg));
    }
    if (value.startsWith("/mode")) {
      const mode = value.replace("/mode", "").trim().toLowerCase() as BridgeMode;
      const validModes = config.bridgeIdeTarget === "windsurf" ? ["ask", "code", "plan"] : ["ask", "code", "plan", "debug"];
      if (!validModes.includes(mode)) {
        return `模式无效。请使用：/mode ${validModes.join("|")}`;
      }
      return TextSecurityGuard.sanitizeOutbound(await this.bridge.switchMode(mode));
    }
    if (value === "/newchat") {
      // Allow raw output so diagnostic fields (e.g., new chat candidates) are visible to the user
      return await this.bridge.newChat();
    }
    if (value === "/context") {
      return TextSecurityGuard.sanitizeOutbound(await this.bridge.contextStatus());
    }
    if (value === "/usage") {
      return TextSecurityGuard.sanitizeOutbound(await this.bridge.usageStatus());
    }
    if (value === "/restart") {
      return TextSecurityGuard.sanitizeOutbound(await this.bridge.restart());
    }
    if (value === "/diag") {
      // Allow raw diagnostics output (no redaction) for troubleshooting
      return await this.bridge.diagnostics();
    }
    if (value === "/chats" || value === "/targets") {
      return TextSecurityGuard.sanitizeOutbound(await this.bridge.listChats());
    }
    if (value.startsWith("/target")) {
      const arg = value.replace("/target", "").trim().toLowerCase();
      if (!arg) {
        return TextSecurityGuard.sanitizeOutbound(await this.bridge.targetStatus());
      }
      if (arg === "auto") {
        return TextSecurityGuard.sanitizeOutbound(await this.bridge.selectTarget("auto"));
      }
      const index = Number(arg);
      if (!Number.isInteger(index) || index <= 0) {
        return "目标无效。请使用 /target <序号> 或 /target auto。";
      }
      return TextSecurityGuard.sanitizeOutbound(await this.bridge.selectTarget(index));
    }
    if (value === "/queue") {
      return "附件队列仅在 Telegram 中可用。";
    }
    if (value === "/clearqueue") {
      return "附件队列仅在 Telegram 中可用。";
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
      const latest = await this.bridge.latestResponse();
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
    const latest = (await this.bridge.latestResponse())
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
      const response = await this.bridge.relayPrompt(prompt, relayOptions);
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

  private channelKeyToNumber(channelId: string): number {
    let hash = 0;
    for (let i = 0; i < channelId.length; i += 1) {
      hash = (hash * 31 + channelId.charCodeAt(i)) >>> 0;
    }
    return hash;
  }

  private helpText(): string {
    return [
      "Courier 命令：",
      config.bridgeIdeTarget === "windsurf" ? "/mode ask|code|plan" : "/mode ask|code|plan|debug  切换模式",
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
      "/chats  列出 IDE 目标",
      "/targets  同 /chats",
      "/target <序号>|auto  选择目标",
      "/diag  诊断",
      "/whoami  查看你的 QQ openid"
    ].join("\n");
  }
}

