import { CursorAutomationClient } from "../cursor/CursorAutomationClient";
import { CursorContextExtractor } from "../cursor/CursorContextExtractor";
import { CursorSqliteDiagnostics } from "../cursor/CursorSqliteDiagnostics";
import { spawn } from "child_process";
import path from "path";
import { WindsurfAutomationClient } from "../windsurf/WindsurfAutomationClient";
import { ImageInjectionService } from "../media/ImageInjectionService";
import { BridgeMode, SendPromptOptions } from "../types";
import { config, IDE_TARGETS, IdeTarget, ideDisplayName } from "../config";
import { CodexAutomationClient } from "../codex/CodexAutomationClient";
import { CursorApiBackend } from "../backends/CursorApiBackend";
import { logger } from "../logger";
import { VscodeAutomationClient } from "../vscode/VscodeAutomationClient";

type IdeClient = CursorAutomationClient | WindsurfAutomationClient | VscodeAutomationClient | CodexAutomationClient;

export class BridgeService {
  private readonly apiBackend = new CursorApiBackend();
  private readonly sqliteDiagnostics = new CursorSqliteDiagnostics();
  private readonly clients: Record<IdeTarget, IdeClient>;
  private readonly injectors: Record<IdeTarget, ImageInjectionService>;
  private readonly contexts = new Map<IdeTarget, CursorContextExtractor>();

  constructor() {
    this.clients = {
      cursor: new CursorAutomationClient(),
      windsurf: new WindsurfAutomationClient(),
      vscode: new VscodeAutomationClient(),
      codex: new CodexAutomationClient()
    };
    this.injectors = {
      cursor: new ImageInjectionService("cursor"),
      windsurf: new ImageInjectionService("windsurf"),
      vscode: new ImageInjectionService("vscode"),
      codex: new ImageInjectionService("codex")
    };
  }

  private resolve(ide?: IdeTarget): IdeTarget {
    return ide ?? config.bridgeIdeTarget;
  }

  private client(ide?: IdeTarget): IdeClient {
    return this.clients[this.resolve(ide)];
  }

  private injector(ide?: IdeTarget): ImageInjectionService {
    return this.injectors[this.resolve(ide)];
  }

  private contextExtractor(ide?: IdeTarget): CursorContextExtractor {
    const key = this.resolve(ide);
    const existing = this.contexts.get(key);
    if (existing) {
      return existing;
    }
    const created = new CursorContextExtractor(key);
    this.contexts.set(key, created);
    return created;
  }

  async restart(): Promise<string> {
    // Relaunch using platform-specific .bat launchers (Windows-only).
    const cwd = path.resolve(__dirname, "..", "..");
    const env = { ...process.env };
    if (!env.DOTENV_CONFIG_PATH) delete env.DOTENV_CONFIG_PATH;

    const script =
      config.bridgeIdeTarget === "windsurf"
        ? "run-windsurf.bat"
        : config.bridgeIdeTarget === "vscode"
          ? "run-vscode.bat"
          : config.bridgeIdeTarget === "codex"
            ? "run-codex.bat"
            : "run-cursor.bat";
    const scriptPath = path.resolve(cwd, script);

    try {
      const child = spawn("cmd.exe", ["/c", scriptPath], {
        cwd,
        env,
        detached: true,
        stdio: "ignore",
        windowsHide: true
      });
      child.unref();
    } catch (error) {
      logger.error({ error }, "Failed to spawn restart process via launcher", { scriptPath });
      return "Restart failed to launch.";
    }

    setTimeout(() => {
      process.exit(0);
    }, 500);

    return "Restarting bridge...";
  }

  async switchMode(mode: BridgeMode, ide?: IdeTarget): Promise<string> {
    if (config.bridgeBackendMode === "api") {
      return (await this.apiBackend.switchMode(mode)).text;
    }
    const result = await this.client(ide).setMode(mode);
    return result.text;
  }

  async relayPrompt(prompt: string, options?: SendPromptOptions, ide?: IdeTarget): Promise<string> {
    if (config.bridgeBackendMode === "api") {
      return (await this.apiBackend.relayPrompt(prompt)).text;
    }
    const result = await this.client(ide).sendPrompt(prompt, options);
    return result.text;
  }

  async relayPromptForPendingAttachment(
    prompt: string,
    kind: "photo" | "document",
    fileName?: string,
    options?: SendPromptOptions,
    ide?: IdeTarget
  ): Promise<string> {
    const relayOptions: SendPromptOptions = {
      preferAttachmentComposer: true,
      attachmentKind: kind,
      ...options
    };
    if (fileName) {
      relayOptions.attachmentFileName = fileName;
    }
    const result = await this.client(ide).sendPrompt(prompt, relayOptions);
    return result.text;
  }

  async latestResponse(ide?: IdeTarget): Promise<string | null> {
    if (config.bridgeBackendMode === "api") {
      return await this.apiBackend.latestResponse();
    }
    return await this.client(ide).latestAssistantSnippet();
  }

  async newChat(ide?: IdeTarget): Promise<string> {
    if (config.bridgeBackendMode === "api") {
      return (await this.apiBackend.newChat()).text;
    }
    const result = await this.client(ide).newChat();
    return result.text;
  }

  async getModel(ide?: IdeTarget): Promise<string> {
    if (config.bridgeBackendMode === "api") {
      return "API 后端模式下无法探测模型。";
    }
    const result = await this.client(ide).getModel();
    return result.text;
  }

  async setModel(modelName: string, ide?: IdeTarget): Promise<string> {
    if (config.bridgeBackendMode === "api") {
      return "API 后端模式下无法切换模型。";
    }
    const result = await this.client(ide).setModel(modelName);
    return result.text;
  }

  async listModels(ide?: IdeTarget): Promise<string> {
    if (config.bridgeBackendMode === "api") {
      return "API 后端模式下无法列出模型。";
    }
    const target = this.resolve(ide);
    const selected = this.clients[target];
    if (target === "windsurf" && selected instanceof WindsurfAutomationClient) {
      const result = await selected.listModels();
      return result.text;
    }
    if (target === "vscode" && selected instanceof VscodeAutomationClient) {
      const result = await selected.listModels();
      return result.text;
    }
    if (target === "codex" && selected instanceof CodexAutomationClient) {
      const result = await selected.listModels();
      return result.text;
    }
    return "目前只有 Windsurf、VS Code 和 Codex 支持列出模型。";
  }

  async contextStatus(ide?: IdeTarget): Promise<string> {
    const context = await this.contextExtractor(ide).readContextPercentage();

    const percentText = context.percent === null ? "不可用" : `${context.percent}%`;
    return [
      "Context 状态",
      `• Context ${percentText}`
    ].join("\n");
  }

  async usageStatus(ide?: IdeTarget): Promise<string> {
    const context = await this.contextExtractor(ide).readContextPercentage();

    const lines = [
      "用量状态",
      `• Context ${context.percent === null ? "不可用" : `${context.percent}%`}`,
      `• Token 用量：没有稳定的公开接口，目前只能按界面上的 Context 做 best-effort 估算。`
    ];
    return lines.join("\n");
  }

  private async routedTargets(): Promise<Array<{ ide: IdeTarget; localIndex: number; id: string; title: string; pinned: boolean }>> {
    const groups = await Promise.all(
      IDE_TARGETS.map(async (ide) => {
        const client = this.clients[ide];
        const targets = await client.listChatTargets();
        const selection = await client.targetSelectionStatus();
        return targets
          .filter((target) => target.type === "page")
          .slice(0, 10)
          .map((target, index) => ({
            ide,
            localIndex: index + 1,
            id: target.id,
            title: target.title || "（无标题）",
            pinned: selection.mode === "manual" && selection.manualTargetId === target.id
          }));
      })
    );
    return groups.flat();
  }

  async listChats(current?: IdeTarget): Promise<string> {
    if (config.bridgeBackendMode === "api") {
      return "API 后端模式下无法列出目标。";
    }
    const pages = await this.routedTargets();
    if (pages.length === 0) {
      return "没有找到已打开调试端口的窗口。Cursor 用 9222，Codex 用 9225。";
    }
    const active = this.resolve(current);
    const lines = pages.map((page, index) => {
      const currentWindow = page.ide === active && page.pinned;
      const mark = currentWindow ? " [当前]" : "";
      return `${index + 1}. ${ideDisplayName(page.ide)}  ${page.title}${mark}`;
    });
    return ["可用目标：", ...lines, "用 /target <序号> 把当前对话发到这一项，/target auto 改回默认 IDE 的自动选择。"].join("\n");
  }

  async selectRoutedTarget(
    selection: "auto" | number,
    current?: IdeTarget
  ): Promise<{ text: string; ide: IdeTarget | null }> {
    if (config.bridgeBackendMode === "api") {
      return { text: "API 后端模式下无法选择目标。", ide: null };
    }
    if (selection === "auto") {
      const ide = this.resolve(current);
      await this.client(ide).selectTarget("auto");
      return { text: `已改回自动选择，之后发到 ${ideDisplayName()}。`, ide: null };
    }
    const pages = await this.routedTargets();
    const chosen = pages[selection - 1];
    if (!chosen) {
      return { text: `目标序号 ${selection} 无效。请用 /targets 查看（1-${pages.length}）。`, ide: null };
    }
    await this.client(chosen.ide).selectTarget(chosen.localIndex);
    return { text: `当前对话改发到 ${ideDisplayName(chosen.ide)}：${chosen.title}`, ide: chosen.ide };
  }

  async targetStatus(ide?: IdeTarget): Promise<string> {
    if (config.bridgeBackendMode === "api") {
      return "API 后端模式下无法选择目标。";
    }
    const target = this.resolve(ide);
    const selection = await this.client(target).targetSelectionStatus();
    if (selection.mode === "auto") {
      return `当前对话：${ideDisplayName(target)}，窗口自动选择。发 /targets 查看全部。`;
    }
    return `当前对话：${ideDisplayName(target)}，窗口 ${selection.manualTargetTitle ?? "未知"}。`;
  }

  async diagnostics(ide?: IdeTarget): Promise<string> {
    if (config.bridgeBackendMode === "api") {
      return await this.apiBackend.diagnostics();
    }

    const target = this.resolve(ide);
    const ideName = ideDisplayName(target);
    const diag = await this.client(target).diagnostics();

    const sel: {
      newChatCandidates?: number;
      newChatBestLabel?: string;
      fallbackTextboxCandidates?: number;
      fallbackResponseCandidates?: number;
    } =
      (diag && typeof diag === "object" && "selectorHealth" in diag && typeof diag.selectorHealth === "object"
        ? (diag.selectorHealth as {
            newChatCandidates?: number;
            newChatBestLabel?: string;
            fallbackTextboxCandidates?: number;
            fallbackResponseCandidates?: number;
          })
        : {}) || {};

    const lines = [
      `桥接诊断（${ideName}）`,
      `- ideTarget: ${target}`,
      `- cdpReachable: ${diag.cdpReachable}`,
      `- versionEndpointReachable: ${diag.versionEndpointReachable}`,
      `- targets: total=${diag.targetCount}, pages=${diag.pageTargetCount}`,
      `- selectedTargetTitle: ${diag.selectedTargetTitle ?? "none"}`,
      `- chatInputFocusable: ${diag.chatInputFocusable === null ? "n/a" : diag.chatInputFocusable}`,
      `- detectedMode: ${diag.detectedMode ?? "unknown"}`,
      `- selectorHealth.chatInputMatches: ${diag.selectorHealth.configuredChatInputMatches}`,
      `- selectorHealth.responseMatches: ${diag.selectorHealth.configuredResponseMatches}`,
      `- selectorHealth.fallbackTextboxCandidates: ${sel.fallbackTextboxCandidates ?? "n/a"}`,
      `- selectorHealth.fallbackResponseCandidates: ${sel.fallbackResponseCandidates ?? "n/a"}`,
      `- selectorHealth.newChatCandidates: ${sel.newChatCandidates ?? "n/a"}`,
      `- selectorHealth.newChatBestLabel: ${sel.newChatBestLabel ?? "none"}`
    ];

    // Cursor-specific extras
    if (target === "cursor") {
      const context = await this.contextExtractor(target).readContextPercentage();
      const sqlite = await this.sqliteDiagnostics.probe();
      const percentText = context.percent === null ? "不可用" : `${context.percent}%`;
      const contextLine = `- context: **${percentText}** (source=${context.source}, confidence=${context.confidence})`;

      lines.push(contextLine, `- sqlite: ${sqlite}`);
    }

    return lines.join("\n");
  }

  async injectPhoto(
    filePath: string,
    options?: { autoSubmit?: boolean; fileName?: string; mimeType?: string; prompt?: string },
    ide?: IdeTarget
  ): Promise<string> {
    if (config.bridgeBackendMode === "api") {
      return "API 后端模式下无法注入图片。";
    }
    const result = await this.injector(ide).injectPhotoFromTelegramFile(filePath, options);
    return result.text;
  }

  async injectDocument(
    filePath: string,
    options?: { autoSubmit?: boolean; fileName?: string; mimeType?: string; prompt?: string },
    ide?: IdeTarget
  ): Promise<string> {
    if (config.bridgeBackendMode === "api") {
      return "API 后端模式下无法注入文件。";
    }
    const result = await this.injector(ide).injectDocumentFromTelegramFile(filePath, options);
    return result.text;
  }
}
