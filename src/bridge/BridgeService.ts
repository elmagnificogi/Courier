import { CursorAutomationClient } from "../cursor/CursorAutomationClient";
import { CursorContextExtractor } from "../cursor/CursorContextExtractor";
import { CursorSqliteDiagnostics } from "../cursor/CursorSqliteDiagnostics";
import { spawn } from "child_process";
import path from "path";
import { WindsurfAutomationClient } from "../windsurf/WindsurfAutomationClient";
import { ImageInjectionService } from "../media/ImageInjectionService";
import { BridgeMode, SendPromptOptions } from "../types";
import { config } from "../config";
import { CursorApiBackend } from "../backends/CursorApiBackend";
import { logger } from "../logger";
import { VscodeAutomationClient } from "../vscode/VscodeAutomationClient";

type IdeClient = CursorAutomationClient | WindsurfAutomationClient | VscodeAutomationClient;

export class BridgeService {
  private readonly apiBackend = new CursorApiBackend();
  private readonly ideClient: IdeClient;

  constructor(
    private readonly cursorClient = new CursorAutomationClient(),
    private readonly contextExtractor = new CursorContextExtractor(),
    private readonly sqliteDiagnostics = new CursorSqliteDiagnostics(),
    private readonly imageInjector = new ImageInjectionService(),
    private readonly vscodeClient = new VscodeAutomationClient()
  ) {
    if (config.bridgeIdeTarget === "windsurf") {
      this.ideClient = new WindsurfAutomationClient();
    } else if (config.bridgeIdeTarget === "vscode") {
      this.ideClient = this.vscodeClient;
    } else {
      this.ideClient = this.cursorClient;
    }
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

  async switchMode(mode: BridgeMode): Promise<string> {
    if (config.bridgeBackendMode === "api") {
      return (await this.apiBackend.switchMode(mode)).text;
    }
    const result = await this.ideClient.setMode(mode);
    return result.text;
  }

  async relayPrompt(prompt: string, options?: SendPromptOptions): Promise<string> {
    if (config.bridgeBackendMode === "api") {
      return (await this.apiBackend.relayPrompt(prompt)).text;
    }
    const result = await this.ideClient.sendPrompt(prompt, options);
    return result.text;
  }

  async relayPromptForPendingAttachment(
    prompt: string,
    kind: "photo" | "document",
    fileName?: string
  ): Promise<string> {
    const options: { preferAttachmentComposer?: boolean; attachmentKind?: "photo" | "document"; attachmentFileName?: string } = {
      preferAttachmentComposer: true,
      attachmentKind: kind
    };
    if (fileName) {
      options.attachmentFileName = fileName;
    }
    const result = await this.ideClient.sendPrompt(prompt, options);
    return result.text;
  }

  async latestResponse(): Promise<string | null> {
    if (config.bridgeBackendMode === "api") {
      return await this.apiBackend.latestResponse();
    }
    return await this.ideClient.latestAssistantSnippet();
  }

  async newChat(): Promise<string> {
    if (config.bridgeBackendMode === "api") {
      return (await this.apiBackend.newChat()).text;
    }
    const result = await this.ideClient.newChat();
    return result.text;
  }

  async getModel(): Promise<string> {
    if (config.bridgeBackendMode === "api") {
      return "API 后端模式下无法探测模型。";
    }
    const result = await this.ideClient.getModel();
    return result.text;
  }

  async setModel(modelName: string): Promise<string> {
    if (config.bridgeBackendMode === "api") {
      return "API 后端模式下无法切换模型。";
    }
    const result = await this.ideClient.setModel(modelName);
    return result.text;
  }

  async listModels(): Promise<string> {
    if (config.bridgeBackendMode === "api") {
      return "API 后端模式下无法列出模型。";
    }
    if (config.bridgeIdeTarget === "windsurf" && this.ideClient instanceof WindsurfAutomationClient) {
      const result = await this.ideClient.listModels();
      return result.text;
    }
    if (config.bridgeIdeTarget === "vscode" && this.ideClient instanceof VscodeAutomationClient) {
      const result = await this.ideClient.listModels();
      return result.text;
    }
    return "目前只有 Windsurf 和 VS Code 支持列出模型。";
  }

  async contextStatus(): Promise<string> {
    const context = await this.contextExtractor.readContextPercentage();

    const percentText = context.percent === null ? "不可用" : `${context.percent}%`;
    return [
      "Context 状态",
      `• Context ${percentText}`
    ].join("\n");
  }

  async usageStatus(): Promise<string> {
    const context = await this.contextExtractor.readContextPercentage();

    const lines = [
      "用量状态",
      `• Context ${context.percent === null ? "不可用" : `${context.percent}%`}`,
      `• Token 用量：没有稳定的公开接口，目前只能按界面上的 Context 做 best-effort 估算。`
    ];
    return lines.join("\n");
  }

  async listChats(): Promise<string> {
    if (config.bridgeBackendMode === "api") {
      return "API 后端模式下无法列出目标。";
    }
    const ideName = config.bridgeIdeTarget === "windsurf" ? "Windsurf" : config.bridgeIdeTarget === "vscode" ? "VS Code" : "Cursor";
    const targets = await this.ideClient.listChatTargets();
    const selection = await this.ideClient.targetSelectionStatus();
    if (targets.length === 0) {
      return `没有找到 ${ideName} 的 CDP 目标。`;
    }

    const lines = targets
      .filter((target) => target.type === "page")
      .slice(0, 10)
      .map((target, index) => {
        const pinned = selection.mode === "manual" && selection.manualTargetId === target.id ? " [已固定]" : "";
        return `${index + 1}. ${target.title || "（无标题）"}${pinned}`;
      });

    const header =
      selection.mode === "manual"
        ? `${ideName} 目标（选择：手动 → ${selection.manualTargetTitle ?? "未知"}）`
        : `${ideName} 目标（选择：自动）`;
    return `${header}\n${lines.join("\n")}`;
  }

  async selectTarget(selection: "auto" | number): Promise<string> {
    if (config.bridgeBackendMode === "api") {
      return "API 后端模式下无法选择目标。";
    }
    const result = await this.ideClient.selectTarget(selection);
    return result.text;
  }

  async targetStatus(): Promise<string> {
    if (config.bridgeBackendMode === "api") {
      return "API 后端模式下无法选择目标。";
    }
    const selection = await this.ideClient.targetSelectionStatus();
    if (selection.mode === "auto") {
      return "目标选择：自动。";
    }
    return `目标选择：手动 ${selection.manualTargetTitle ?? "（未知标题）"}（${selection.manualTargetId ?? "未知 id"}）。`;
  }

  async diagnostics(): Promise<string> {
    if (config.bridgeBackendMode === "api") {
      return await this.apiBackend.diagnostics();
    }

    const ideName = config.bridgeIdeTarget === "windsurf" ? "Windsurf" : config.bridgeIdeTarget === "vscode" ? "VS Code" : "Cursor";
    const diag = await this.ideClient.diagnostics();

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
      `- ideTarget: ${config.bridgeIdeTarget}`,
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
    if (config.bridgeIdeTarget === "cursor") {
      const context = await this.contextExtractor.readContextPercentage();
      const sqlite = await this.sqliteDiagnostics.probe();
      const percentText = context.percent === null ? "不可用" : `${context.percent}%`;
      const contextLine = `- context: **${percentText}** (source=${context.source}, confidence=${context.confidence})`;

      lines.push(contextLine, `- sqlite: ${sqlite}`);
    }

    return lines.join("\n");
  }

  async injectPhoto(
    filePath: string,
    options?: { autoSubmit?: boolean; fileName?: string; mimeType?: string; prompt?: string }
  ): Promise<string> {
    if (config.bridgeBackendMode === "api") {
      return "API 后端模式下无法注入图片。";
    }
    const result = await this.imageInjector.injectPhotoFromTelegramFile(filePath, options);
    return result.text;
  }

  async injectDocument(
    filePath: string,
    options?: { autoSubmit?: boolean; fileName?: string; mimeType?: string; prompt?: string }
  ): Promise<string> {
    if (config.bridgeBackendMode === "api") {
      return "API 后端模式下无法注入文件。";
    }
    const result = await this.imageInjector.injectDocumentFromTelegramFile(filePath, options);
    return result.text;
  }
}
