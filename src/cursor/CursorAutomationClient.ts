import { exec } from "node:child_process";
import { promisify } from "node:util";
import { AgentProgressEvent, BridgeMode, BridgeResponse, SendPromptOptions } from "../types";
import { logger } from "../logger";
import { config } from "../config";
import { ClientDomains, CursorCdpClient, CursorTargetSummary, wait } from "./CursorCdpClient";

const execAsync = promisify(exec);
type DetectedMode = "Agent" | "Code" | "Ask" | "Debug" | "Plan";

/**
 * Cursor integration status:
 * - mode switching shortcuts: official behavior in Cursor docs
 * - direct UI automation shelling: best-effort fallback
 */
export class CursorAutomationClient {
  private readonly cdp = new CursorCdpClient();
  private readonly modeLabelAliases: Record<BridgeMode, string[]> = {
    ask: ["Ask"],
    code: ["Agent", "Code"],
    plan: ["Plan"],
    debug: ["Debug"]
  };

  async listChatTargets(): Promise<CursorTargetSummary[]> {
    try {
      return await this.cdp.listTargets();
    } catch (error) {
      logger.warn({ error }, "Failed to list Cursor targets through CDP");
      return [];
    }
  }

  private async sampleDomMarkers(client: ClientDomains): Promise<{
    chat: { tag: string; role: string | null; cls: string }[];
    response: { tag: string; role: string | null; cls: string }[];
  }> {
    const expression = `
      (() => {
        const isVis = (el) => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          const s = window.getComputedStyle(el);
          return r.width > 3 && r.height > 3 && s.visibility !== 'hidden' && s.display !== 'none';
        };

        const topN = (arr, n = 5) => arr.slice(0, n);

        const chat = Array.from(document.querySelectorAll('textarea,[contenteditable="true"],[role="textbox"]'))
          .filter(isVis)
          .map((el) => ({
            tag: (el.tagName || '').toLowerCase(),
            role: el.getAttribute('role'),
            cls: String(el.className || '').replace(/\s+/g, ' ').trim().slice(0, 200)
          }));

        const resp = Array.from(document.querySelectorAll('[class*="prose"],[class*="markdown"],[class*="assistant"],[class*="message"],article,[role="article"],.composer-rendered-message,.anysphere-markdown-container-root'))
          .filter(isVis)
          .map((el) => ({
            tag: (el.tagName || '').toLowerCase(),
            role: el.getAttribute('role'),
            cls: String(el.className || '').replace(/\s+/g, ' ').trim().slice(0, 200)
          }));

        return { chat: topN(chat), response: topN(resp) };
      })();
    `;

    const result = await this.cdp.evaluateJson<{
      chat: { tag: string; role: string | null; cls: string }[];
      response: { tag: string; role: string | null; cls: string }[];
    }>(client, expression);

    return {
      chat: result?.chat ?? [],
      response: result?.response ?? []
    };
  }

  async targetSelectionStatus(): Promise<{
    mode: "auto" | "manual";
    manualTargetId: string | null;
    manualTargetTitle: string | null;
  }> {
    try {
      return await this.cdp.getSelectionState();
    } catch (error) {
      logger.warn({ error }, "Failed to read target selection state");
      return {
        mode: "auto",
        manualTargetId: null,
        manualTargetTitle: null
      };
    }
  }

  async selectTarget(selection: "auto" | number): Promise<BridgeResponse> {
    if (selection === "auto") {
      this.cdp.clearManualTarget();
      return {
        text: "已切换为自动选择目标。",
        metadata: { target_mode: "auto" }
      };
    }

    const target = await this.cdp.setManualTargetByPageIndex(selection - 1);
    if (!target) {
      const pages = await this.cdp.listPageTargets();
      return {
        text: `目标序号 ${selection} 无效。请用 /targets 查看有效范围（1-${pages.length}）。`,
        metadata: { target_mode: "manual", status: "invalid-index" }
      };
    }

    return {
      text: `已固定目标 #${selection}：${target.title || "（无标题）"}`,
      metadata: { target_mode: "manual", target_id: target.id, target_title: target.title }
    };
  }

  async setMode(mode: BridgeMode): Promise<BridgeResponse> {
    const aliases = this.modeLabelAliases[mode];

    logger.info({ mode }, "Requested mode switch");

    try {
      const switched = await this.cdp.withClient(async (client): Promise<{ ok: boolean; detectedMode: string | null }> => {
        const preCandidates = await this.readModeCandidates(client);
        const focused = await this.focusChatInput(client);
        if (!focused) {
          logger.info({ mode, preCandidates }, "Mode switch: chat input not focusable");
          return { ok: false, detectedMode: null };
        }

        const initialMode = await this.detectCurrentMode(client);
        logger.info({ mode, initialMode, preCandidates }, "Mode switch: initial detection");
        if (initialMode && aliases.includes(initialMode)) {
          return { ok: true, detectedMode: initialMode };
        }

        // Prefer deterministic click on matching mode button labels.
        const clicked = await this.clickModeButton(client, aliases);
        if (clicked) {
          await wait(180);
          const afterClickMode = await this.detectCurrentMode(client);
          const postCandidates = await this.readModeCandidates(client);
          logger.info(
            { mode, aliases, clicked, afterClickMode, postCandidates },
            "Mode switch: click attempt result"
          );
          if (afterClickMode && aliases.includes(afterClickMode)) {
            return { ok: true, detectedMode: afterClickMode };
          }
          // If click changed to a different known mode, avoid extra rotations.
          if (afterClickMode && initialMode && afterClickMode !== initialMode) {
            return { ok: false, detectedMode: afterClickMode };
          }
          // If click did not change mode (or detection is unavailable), proceed to
          // keyboard fallback for deterministic progression.
        }

        const fallbackMode = await this.detectCurrentMode(client);
        logger.info({ mode, fallbackMode }, "Mode switch: keyboard fallback check");
        if (fallbackMode) {
          // Verified-mode fallback: rotate only while detection exists.
          for (let attempt = 0; attempt < 8; attempt += 1) {
            await this.cdp.sendShortcut(client, "Tab", "Tab", 9, 8);
            await wait(180);
            const currentMode = await this.detectCurrentMode(client);
            logger.info({ mode, attempt: attempt + 1, currentMode }, "Mode switch: keyboard rotation step");
            if (currentMode && aliases.includes(currentMode)) {
              return { ok: true, detectedMode: currentMode };
            }
            if (!currentMode) {
              // If detection disappears mid-loop, stop to avoid cycling back.
              break;
            }
          }
          return { ok: false, detectedMode: await this.detectCurrentMode(client) };
        }

        // Last-resort: single-step rotate only once when mode cannot be detected.
        // This avoids accidental full-cycle wraparound back to the original mode.
        await this.cdp.sendShortcut(client, "Tab", "Tab", 9, 8);
        await wait(180);
        const finalDetected = await this.detectCurrentMode(client);
        logger.info({ mode, finalDetected }, "Mode switch: last-resort single rotation");
        return { ok: false, detectedMode: finalDetected };
      });

      if (!switched.ok) {
        return {
          text: `${mode} 模式切换未能确认。当前检测到的模式：${switched.detectedMode ?? "未知"}。`,
          metadata: {
            mapped_to: aliases.join("/"),
            detected_mode: switched.detectedMode,
            status: "unverified"
          }
        };
      }

      return {
        text: `已切换模式：${mode} → ${switched.detectedMode ?? aliases[0]}。`,
        metadata: {
          mapped_to: aliases.join("/"),
          detected_mode: switched.detectedMode,
          status: "verified"
        }
      };
    } catch (error) {
      logger.warn({ error, mode }, "CDP mode switching failed");
      return {
        text: `通过 CDP 切换 ${mode} 模式失败。`,
        metadata: { mapped_to: aliases.join("/"), status: "failed" }
      };
    }
  }

  async sendPrompt(prompt: string, options?: SendPromptOptions): Promise<BridgeResponse> {
    logger.info({ length: prompt.length }, "Prompt relay requested");

    try {
      const relayResult = await this.cdp.withClient(async (client) => {
        const focusOptions: {
          preferAttachmentComposer?: boolean;
          attachmentKind?: "photo" | "document";
          attachmentFileName?: string;
        } = {
          preferAttachmentComposer: options?.preferAttachmentComposer === true
        };
        if (options?.attachmentKind) {
          focusOptions.attachmentKind = options.attachmentKind;
        }
        if (options?.attachmentFileName) {
          focusOptions.attachmentFileName = options.attachmentFileName;
        }
        const focused = await this.focusChatInput(client, focusOptions);
        if (!focused) {
          return { delivered: false, responseSnippet: null as string | null, cancelled: false };
        }

        const baselineSnippet = await this.readLatestAssistantSnippet(client);
        const injected = await this.injectPromptText(client, prompt);
        if (!injected) {
          return { delivered: false, responseSnippet: null as string | null, cancelled: false };
        }

        await this.cdp.sendShortcut(client, "Enter", "Enter", 13, 0);
        const maxWaitMs = options?.onProgress ? config.cursorRelayMaxMs : config.cursorActionTimeoutMs;
        const watchOptions: {
          maxWaitMs: number;
          baselineSnippet: string | null;
          prompt: string;
          onProgress?: (event: AgentProgressEvent) => void | Promise<void>;
          signal?: AbortSignal;
        } = {
          maxWaitMs,
          baselineSnippet,
          prompt
        };
        if (options?.onProgress) {
          watchOptions.onProgress = options.onProgress;
        }
        if (options?.signal) {
          watchOptions.signal = options.signal;
        }
        const responseSnippet = await this.waitForCurrentTurn(client, watchOptions);
        return { delivered: true, responseSnippet, cancelled: responseSnippet === "__cancelled__" };
      });

      if (relayResult.cancelled) {
        return { text: "已取消等待 Cursor 回复。", metadata: { status: "cancelled" } };
      }

      if (!relayResult.delivered) {
        return {
          text: "提示词转发失败：无法聚焦聊天输入框，或文本注入失败。",
          metadata: { status: "failed" }
        };
      }

      if (relayResult.responseSnippet && relayResult.responseSnippet !== "__cancelled__") {
        return {
          text: relayResult.responseSnippet,
          metadata: { status: "delivered" }
        };
      }

      return {
        text:
          "提示词已送达，但还没有捕获到完整回复。\n" +
          "任务可能仍在 Cursor 里执行，稍后发送 /last 获取。",
        metadata: { status: "delivered-no-snippet" }
      };
    } catch (error) {
      logger.warn({ error }, "CDP prompt relay failed");
      return {
        text: "通过 CDP 转发提示词失败。请检查远程调试端口和目标选择。",
        metadata: { status: "failed" }
      };
    }
  }

  async latestAssistantSnippet(): Promise<string | null> {
    try {
      return await this.cdp.withClient(async (client) => {
        return await this.readLatestAssistantSnippet(client);
      });
    } catch (error) {
      logger.warn({ error }, "Failed reading latest assistant snippet");
      return null;
    }
  }

  async getModel(): Promise<BridgeResponse> {
    try {
      const model = await this.cdp.withClient(async (client) => {
        return await this.detectCurrentModel(client);
      });
      if (model) {
        return { text: `当前模型：${model}`, metadata: { model, status: "detected" } };
      }
      return { text: "无法检测当前模型。", metadata: { status: "undetected" } };
    } catch (error) {
      logger.warn({ error }, "CDP model detection failed");
      return { text: "通过 CDP 检测模型失败。", metadata: { status: "failed" } };
    }
  }

  async setModel(modelName: string): Promise<BridgeResponse> {
    try {
      const result = await this.cdp.withClient(async (client) => {
        return await this.clickModelOption(client, modelName);
      });
      if (result.ok) {
        return {
          text: `已切换模型：${result.selectedModel ?? modelName}`,
          metadata: { model: result.selectedModel, status: "switched" }
        };
      }
      return {
        text: `无法切换到模型 "${modelName}"。当前：${result.selectedModel ?? "未知"}。可用 /model 查看当前模型。`,
        metadata: { model: result.selectedModel, status: "not-found" }
      };
    } catch (error) {
      logger.warn({ error, modelName }, "CDP model switching failed");
      return { text: `通过 CDP 切换模型 "${modelName}" 失败。`, metadata: { status: "failed" } };
    }
  }

  async newChat(): Promise<BridgeResponse> {
    // Ctrl+Shift+L / Cmd+Shift+L maps to new chat in current Cursor builds.
    try {
      const result = await this.cdp.withClient(async (client) => {
        const isMac = process.platform === "darwin";
        const modifiers = isMac ? 12 /* Meta+Shift */ : 10 /* Ctrl+Shift */;
        await this.cdp.sendShortcut(client, "l", "KeyL", 76, modifiers);
        await wait(240);
        const focused = await this.focusChatInput(client);
        let cleared = await this.clearChatInput(client);
        if (!cleared) {
          await wait(80);
          if (!focused) {
            await this.focusChatInput(client);
          }
          cleared = await this.clearChatInput(client);
        }
        return { cleared, focused };
      });

      if (result.cleared) {
        return {
          text: "已通过 CDP 发送新对话快捷键，并清空输入框。",
          metadata: { status: "dispatched-cdp-cleared", focused: result.focused }
        };
      }

      // Fallback: send OS keys and try again
      await execAsync(
        "powershell -NoProfile -Command \"Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^+l')\""
      );
      await wait(260);
      const focused = await this.cdp.withClient(async (client) => this.focusChatInput(client));
      const cleared = await this.cdp.withClient(async (client) => this.clearChatInput(client));
      return {
        text: cleared
          ? "New chat shortcut dispatched (CDP + OS) and composer cleared."
          : "New chat shortcut dispatched (CDP + OS). Composer focus/clear not verified.",
        metadata: { status: cleared ? "dispatched-os-cleared" : "dispatched-os", focused }
      };
    } catch (error) {
      logger.warn({ error }, "New chat shortcut dispatch failed");
      return { text: "新对话发送失败，需要在 IDE 里手动处理。", metadata: { status: "failed" } };
    }
  }

  async diagnostics(): Promise<{
    cdpReachable: boolean;
    versionEndpointReachable: boolean;
    targetCount: number;
    pageTargetCount: number;
    selectedTargetTitle: string | null;
    chatInputFocusable: boolean | null;
    detectedMode: DetectedMode | null;
    configuredSelectors: {
      chatInput: string;
      response: string;
      context: string;
    };
    targetSelection: {
      mode: "auto" | "manual";
      manualTargetId: string | null;
      manualTargetTitle: string | null;
    };
    notes: string[];
    selectorHealth: {
      configuredChatInputMatches: number;
      configuredResponseMatches: number;
      configuredContextMatches: number;
      fallbackTextboxCandidates: number;
      fallbackResponseCandidates: number;
    };
  }> {
    const notes: string[] = [];
    const configuredSelectors = {
      chatInput: config.cursorChatInputSelector,
      response: config.cursorResponseSelector,
      context: config.cursorContextSelector
    };

    let versionEndpointReachable = false;
    try {
      const version = await this.cdp.readVersionInfo();
      versionEndpointReachable = Boolean(version?.webSocketDebuggerUrl);
      if (!versionEndpointReachable) {
        notes.push("Version endpoint reachable but webSocketDebuggerUrl missing.");
      }
    } catch (error) {
      logger.warn({ error }, "CDP version endpoint check failed");
      notes.push("Version endpoint check failed.");
    }

    try {
      const targetSelection = await this.cdp.getSelectionState();
      const targets = await this.listChatTargets();
      const pageTargets = targets.filter((target) => target.type === "page");
      if (targets.length === 0) {
        return {
          cdpReachable: false,
          versionEndpointReachable,
          targetCount: 0,
          pageTargetCount: 0,
          selectedTargetTitle: null,
          chatInputFocusable: null,
          detectedMode: null,
          configuredSelectors,
          targetSelection,
          notes: [...notes, "No targets discovered."],
          selectorHealth: {
            configuredChatInputMatches: 0,
            configuredResponseMatches: 0,
            configuredContextMatches: 0,
            fallbackTextboxCandidates: 0,
            fallbackResponseCandidates: 0
          }
        };
      }

      const runtimeCheck = await this.cdp.withClient(async (client, target) => {
        const focusable = await this.focusChatInput(client);
        const mode = await this.detectCurrentMode(client);
        const modeCandidates = await this.readModeCandidates(client);
        const selectorHealth = await this.readSelectorHealth(client);
        const samples = await this.sampleDomMarkers(client);
        return {
          selectedTargetTitle: target.title,
          chatInputFocusable: focusable,
          detectedMode: mode,
          modeCandidates,
          selectorHealth,
          samples
        };
      });

      if (runtimeCheck.modeCandidates.length > 0) {
        notes.push(`Mode candidates: ${runtimeCheck.modeCandidates.join(" | ")}`);
      }

      if (runtimeCheck.samples.chat.length > 0) {
        const rendered = runtimeCheck.samples.chat
          .map((c) => `${c.tag}${c.role ? `[${c.role}]` : ""} class="${c.cls}"`)
          .join(" | ");
        notes.push(`Chat samples: ${rendered}`);
      }

      if (runtimeCheck.samples.response.length > 0) {
        const rendered = runtimeCheck.samples.response
          .map((c) => `${c.tag}${c.role ? `[${c.role}]` : ""} class="${c.cls}"`)
          .join(" | ");
        notes.push(`Response samples: ${rendered}`);
      }

      return {
        cdpReachable: true,
        versionEndpointReachable,
        targetCount: targets.length,
        pageTargetCount: pageTargets.length,
        selectedTargetTitle: runtimeCheck.selectedTargetTitle,
        chatInputFocusable: runtimeCheck.chatInputFocusable,
        detectedMode: runtimeCheck.detectedMode,
        configuredSelectors,
        targetSelection,
        notes,
        selectorHealth: runtimeCheck.selectorHealth
      };
    } catch (error) {
      logger.warn({ error }, "CDP runtime diagnostics failed");
      return {
        cdpReachable: false,
        versionEndpointReachable,
        targetCount: 0,
        pageTargetCount: 0,
        selectedTargetTitle: null,
        chatInputFocusable: null,
        detectedMode: null,
        configuredSelectors,
        targetSelection: {
          mode: "auto",
          manualTargetId: null,
          manualTargetTitle: null
        },
        notes: [...notes, "Runtime diagnostics failed."],
        selectorHealth: {
          configuredChatInputMatches: 0,
          configuredResponseMatches: 0,
          configuredContextMatches: 0,
          fallbackTextboxCandidates: 0,
          fallbackResponseCandidates: 0
        }
      };
    }
  }

  private async readSelectorHealth(client: ClientDomains): Promise<{
    configuredChatInputMatches: number;
    configuredResponseMatches: number;
    configuredContextMatches: number;
    fallbackTextboxCandidates: number;
    fallbackResponseCandidates: number;
  }> {
    const expression = `
      (() => {
        const configuredChat = ${JSON.stringify(config.cursorChatInputSelector)};
        const configuredResp = ${JSON.stringify(config.cursorResponseSelector)};
        const configuredCtx = ${JSON.stringify(config.cursorContextSelector)};
        const count = (sel) => {
          if (!sel) return 0;
          try {
            return document.querySelectorAll(sel).length;
          } catch (_error) {
            return -1;
          }
        };
        const fallbackTextbox = document.querySelectorAll('textarea,[contenteditable="true"],[role="textbox"]').length;
        const fallbackResponse = document.querySelectorAll(
          '[data-role*="assistant"],[class*="assistant"],[data-testid*="assistant"],.composer-rendered-message,.anysphere-markdown-container-root,article,[role="article"],.message'
        ).length;
        return {
          configuredChatInputMatches: count(configuredChat),
          configuredResponseMatches: count(configuredResp),
          configuredContextMatches: count(configuredCtx),
          fallbackTextboxCandidates: fallbackTextbox,
          fallbackResponseCandidates: fallbackResponse
        };
      })();
    `;
    const result = await this.cdp.evaluateJson<{
      configuredChatInputMatches: number;
      configuredResponseMatches: number;
      configuredContextMatches: number;
      fallbackTextboxCandidates: number;
      fallbackResponseCandidates: number;
    }>(client, expression);
    return {
      configuredChatInputMatches: Number(result?.configuredChatInputMatches ?? 0),
      configuredResponseMatches: Number(result?.configuredResponseMatches ?? 0),
      configuredContextMatches: Number(result?.configuredContextMatches ?? 0),
      fallbackTextboxCandidates: Number(result?.fallbackTextboxCandidates ?? 0),
      fallbackResponseCandidates: Number(result?.fallbackResponseCandidates ?? 0)
    };
  }

  private async focusChatInput(
    client: ClientDomains,
    options?: { preferAttachmentComposer?: boolean; attachmentKind?: "photo" | "document"; attachmentFileName?: string }
  ): Promise<boolean> {
    const selectorLiteral = JSON.stringify(config.cursorChatInputSelector);
    const preferAttachmentComposerLiteral = JSON.stringify(options?.preferAttachmentComposer === true);
    const attachmentKindLiteral = JSON.stringify(options?.attachmentKind ?? "document");
    const attachmentFileNameLiteral = JSON.stringify(String(options?.attachmentFileName ?? "").toLowerCase());
    const expression = `
      (() => {
        function isVisible(el) {
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 3 && rect.height > 3 && style.visibility !== 'hidden' && style.display !== 'none';
        }

        const configured = ${selectorLiteral};
        if (configured) {
          const explicit = document.querySelector(configured);
          if (explicit && isVisible(explicit)) {
            explicit.focus();
            return true;
          }
        }

        const candidates = [
          ...Array.from(document.querySelectorAll('textarea')),
          ...Array.from(document.querySelectorAll('[contenteditable="true"]')),
          ...Array.from(document.querySelectorAll('[role="textbox"]'))
        ].filter(isVisible);

        if (candidates.length === 0) return false;

        const attachmentSelectorsFor = (kind) => {
          if (kind === 'photo') {
            return [
              'img',
              '[class*="image"]',
              '[class*="attachment"]',
              '[class*="upload"]',
              '[data-testid*="image"]',
              '[data-testid*="attachment"]'
            ];
          }
          return [
            '[class*="file"]',
            '[class*="document"]',
            '[class*="attachment"]',
            '[class*="upload"]',
            '[data-testid*="file"]',
            '[data-testid*="attachment"]'
          ];
        };
        const attachmentFileName = ${attachmentFileNameLiteral};
        const attachmentFileStem = attachmentFileName.replace(/\\.[^\\.]+$/, '');
        const countAttachmentSignals = (root, kind) => {
          if (!root) return 0;
          let total = 0;
          for (const sel of attachmentSelectorsFor(kind)) {
            total += root.querySelectorAll(sel).length;
          }
          return total;
        };

        const score = (el) => {
          const rect = el.getBoundingClientRect();
          const className = String(el.className || '').toLowerCase();
          const placeholder = String(el.getAttribute('placeholder') || '').toLowerCase();
          const ariaLabel = String(el.getAttribute('aria-label') || '').toLowerCase();
          let value = 0;
          if (el.closest('[class*="composer"],[class*="ai-input"],[class*="input-box"]')) value += 300;
          if (className.includes('composer') || className.includes('ai-input') || className.includes('input-box')) value += 200;
          if (placeholder.includes('follow-up') || placeholder.includes('message') || ariaLabel.includes('follow-up')) value += 180;
          if (el.getAttribute('role') === 'textbox') value += 40;
          if (${preferAttachmentComposerLiteral}) {
            const root = el.closest('[class*="composer"],[class*="ai-input"],[class*="input-box"]') || el.parentElement;
            const attachmentSignals = countAttachmentSignals(root, ${attachmentKindLiteral});
            value += Math.min(360, attachmentSignals * 80);
            if (root && attachmentFileName.length >= 4) {
              const rootText = String(root.innerText || '').toLowerCase();
              if (rootText.includes(attachmentFileName)) {
                value += 500;
              } else if (attachmentFileStem.length >= 4 && rootText.includes(attachmentFileStem)) {
                value += 300;
              }
            }
          }
          // Prefer elements lower in the viewport (chat composer area).
          value += Math.min(180, Math.max(0, rect.top));
          // Penalize huge editor/text areas.
          value -= Math.min(220, Math.round((rect.width * rect.height) / 4000));
          return value;
        };

        candidates.sort((a, b) => {
          const diff = score(b) - score(a);
          if (diff !== 0) return diff;
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          return br.top - ar.top;
        });

        candidates[0].focus();
        return document.activeElement === candidates[0];
      })();
    `;

    const focused = await this.cdp.evaluateJson<boolean>(client, expression);
    return focused === true;
  }

  private async clearChatInput(client: ClientDomains): Promise<boolean> {
    const expression = `
      (() => {
        try {
          const el = document.activeElement as HTMLElement | null;
          if (!el) return false;

          const dispatch = (target, type) => target.dispatchEvent(new Event(type, { bubbles: true }));

          if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
            el.value = "";
            dispatch(el, "input");
            dispatch(el, "change");
            return true;
          }

          if (el.getAttribute && el.getAttribute("contenteditable") === "true") {
            el.textContent = "";
            const InputEvt = typeof InputEvent === "function" ? InputEvent : Event;
            el.dispatchEvent(new InputEvt("input", { bubbles: true, data: "", inputType: "deleteContent" }));
            return true;
          }

          return false;
        } catch (_err) {
          return false;
        }
      })();
    `;

    const cleared = await this.cdp.evaluateJson<boolean>(client, expression);
    return cleared === true;
  }

  private async detectCurrentMode(client: ClientDomains): Promise<DetectedMode | null> {
    const domDetected = await this.detectCurrentModeFromDom(client);
    if (domDetected) {
      return domDetected;
    }
    return await this.detectCurrentModeFromAccessibility(client);
  }

  private async detectCurrentModeFromDom(client: ClientDomains): Promise<DetectedMode | null> {
    const expression = `
      (() => {
        const modeMatchers = [
          { label: 'Agent', key: 'agent' },
          { label: 'Ask', key: 'ask' },
          { label: 'Debug', key: 'debug' },
          { label: 'Plan', key: 'plan' },
          { label: 'Code', key: 'code' }
        ];

        const normalize = (value) => String(value || '').toLowerCase().replace(/\\s+/g, ' ').trim();
        const modeFromText = (textValue) => {
          const text = normalize(textValue);
          if (!text) return null;
          for (const mode of modeMatchers) {
            const re = new RegExp('(^|\\\\b)' + mode.key + '(\\\\b|$)');
            if (re.test(text)) return mode.label;
          }
          return null;
        };

        // Primary signal in current Cursor builds: unified mode chip near composer.
        const dropdowns = Array.from(document.querySelectorAll('[class*="composer-unified-dropdown"]'));
        for (const dropdown of dropdowns) {
          const text = [
            dropdown.textContent || '',
            dropdown.getAttribute('aria-label') || '',
            dropdown.getAttribute('title') || ''
          ].join(' ');
          const mode = modeFromText(text);
          if (mode) return mode;
        }

        const buttons = Array.from(document.querySelectorAll('button,[role="button"],[role="menuitem"],[role="option"]'));
        const parsed = buttons.map((button) => {
          const text = [
            button.textContent || '',
            button.getAttribute('aria-label') || '',
            button.getAttribute('title') || ''
          ].join(' ');
          const mode = modeFromText(text);
          if (!mode) return null;

          const className = normalize(button.className || '');
          const pressed = normalize(button.getAttribute('aria-pressed') || '');
          const selectedByAttr =
            pressed === 'true' ||
            normalize(button.getAttribute('data-state') || '') === 'active' ||
            normalize(button.getAttribute('data-state') || '') === 'selected' ||
            normalize(button.getAttribute('aria-current') || '') === 'true';
          const selectedByClass =
            className.includes('selected') ||
            className.includes('active') ||
            className.includes('current') ||
            className.includes('checked');

          return { button, mode, selectedByAttr, selectedByClass };
        }).filter(Boolean);

        if (parsed.length === 0) return null;

        // Prefer a sibling cluster that contains 3+ distinct modes.
        const groups = new Map();
        for (const item of parsed) {
          const key = item.button.parentElement || item.button;
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(item);
        }
        const clustered = Array.from(groups.values()).filter((group) => {
          const unique = new Set(group.map((item) => item.mode));
          return unique.size >= 3;
        });
        const scope = clustered.length > 0 ? clustered.sort((a, b) => b.length - a.length)[0] : parsed;

        const attrSelected = scope.find((item) => item.selectedByAttr);
        if (attrSelected) return attrSelected.mode;

        const classSelected = scope.find((item) => item.selectedByClass);
        if (classSelected) return classSelected.mode;

        return null;
      })();
    `;
    return await this.cdp.evaluateJson<DetectedMode | null>(client, expression);
  }

  private async clickModeButton(client: ClientDomains, preferredLabels: string[]): Promise<boolean> {
    const labelsLiteral = JSON.stringify(preferredLabels);
    const expression = `
      (() => {
        const preferred = ${labelsLiteral}.map((x) => String(x || '').toLowerCase());
        const normalize = (value) => String(value || '').toLowerCase().replace(/\\s+/g, ' ').trim();
        const modeMatchers = [
          { label: 'agent', key: 'agent' },
          { label: 'ask', key: 'ask' },
          { label: 'debug', key: 'debug' },
          { label: 'plan', key: 'plan' },
          { label: 'code', key: 'code' }
        ];
        const modeFromText = (textValue) => {
          const text = normalize(textValue);
          if (!text) return null;
          for (const mode of modeMatchers) {
            const re = new RegExp('(^|\\\\b)' + mode.key + '(\\\\b|$)');
            if (re.test(text)) return mode.label;
          }
          return null;
        };
        const isVisible = (el) => {
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 3 && rect.height > 3 && style.visibility !== 'hidden' && style.display !== 'none';
        };

        const buttons = Array.from(document.querySelectorAll('button,[role="button"],[role="menuitem"],[role="option"]'));
        const dropdowns = Array.from(document.querySelectorAll('[class*="composer-unified-dropdown"]')).filter((el) => isVisible(el));
        for (const dropdown of dropdowns) {
          const dropdownText = normalize([
            dropdown.textContent || '',
            dropdown.getAttribute('aria-label') || '',
            dropdown.getAttribute('title') || ''
          ].join(' '));
          const currentMode = modeFromText(dropdownText);
          if (currentMode && preferred.includes(currentMode)) {
            return true;
          }

          dropdown.click();
          const dr = dropdown.getBoundingClientRect();
          const optionNodes = Array.from(
            document.querySelectorAll('button,[role="button"],[role="menuitem"],[role="option"],div,span,a')
          ).filter((el) => isVisible(el));
          const options = optionNodes
            .map((el) => {
              const text = normalize([
                el.textContent || '',
                el.getAttribute('aria-label') || '',
                el.getAttribute('title') || ''
              ].join(' '));
              const mode = modeFromText(text);
              if (!mode) return null;
              const er = el.getBoundingClientRect();
              const near = Math.abs(er.left - dr.left) <= 420 && Math.abs(er.top - dr.top) <= 520;
              if (!near) return null;
              return { el, mode, tag: (el.tagName || '').toLowerCase(), role: normalize(el.getAttribute('role') || '') };
            })
            .filter(Boolean);

          for (const preferredLabel of preferred) {
            const hit = options.find((option) => option.mode === preferredLabel && (option.role || option.tag === 'button'));
            if (hit) {
              hit.el.click();
              return true;
            }
          }
          for (const preferredLabel of preferred) {
            const hit = options.find((option) => option.mode === preferredLabel);
            if (hit) {
              hit.el.click();
              return true;
            }
          }
        }

        const entries = buttons.map((button) => {
          const text = normalize([
            button.textContent || '',
            button.getAttribute('aria-label') || '',
            button.getAttribute('title') || ''
          ].join(' '));
          return {
            button,
            text,
            mode: modeFromText(text)
          };
        }).filter((entry) => entry.mode && isVisible(entry.button));

        const groups = new Map();
        for (const entry of entries) {
          const key = entry.button.parentElement || entry.button;
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(entry);
        }
        const clustered = Array.from(groups.values()).filter((group) => {
          const unique = new Set(group.map((entry) => entry.mode));
          return unique.size >= 3;
        });
        const scope = clustered.length > 0 ? clustered.sort((a, b) => b.length - a.length)[0] : entries;

        for (const preferredLabel of preferred) {
          const hit = scope.find((entry) => entry.mode === preferredLabel);
          if (hit) {
            hit.button.click();
            return true;
          }
        }

        return false;
      })();
    `;
    return (await this.cdp.evaluateJson<boolean>(client, expression)) === true;
  }

  private async readModeCandidates(client: ClientDomains): Promise<string[]> {
    const domCandidatesExpression = `
      (() => {
        const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
        const isVisible = (el) => {
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 3 && rect.height > 3 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const hasModeWord = (text) => /(^|\\b)(agent|ask|debug|plan|code)(\\b|$)/i.test(text);
        const nodes = Array.from(
          document.querySelectorAll('button,[role="button"],[role="menuitem"],[role="option"],[class*="composer-unified-dropdown"]')
        );
        const rows = nodes
          .filter((node) => isVisible(node))
          .map((node) => {
            const text = normalize([
              node.textContent || '',
              node.getAttribute('aria-label') || '',
              node.getAttribute('title') || ''
            ].join(' '));
            if (!text || !hasModeWord(text)) return null;
            const className = normalize(node.className || '');
            const pressed = normalize(node.getAttribute('aria-pressed') || '');
            const selected =
              pressed === 'true' ||
              normalize(node.getAttribute('data-state') || '') === 'active' ||
              normalize(node.getAttribute('data-state') || '') === 'selected' ||
              normalize(node.getAttribute('aria-current') || '') === 'true' ||
              className.includes('selected') ||
              className.includes('active') ||
              className.includes('current') ||
              className.includes('checked');
            return (selected ? '[*]' : '[ ]') + ' [DOM] ' + text;
          })
          .filter(Boolean);
        return rows.slice(0, 30);
      })();
    `;
    const domCandidates = await this.cdp.evaluateJson<string[]>(client, domCandidatesExpression);
    const axCandidates = await this.readModeCandidatesFromAccessibility(client);
    return [...(Array.isArray(domCandidates) ? domCandidates : []), ...axCandidates];
  }

  private async detectCurrentModeFromAccessibility(client: ClientDomains): Promise<DetectedMode | null> {
    const tree = await client.Accessibility?.getFullAXTree?.();
    const nodes = tree?.nodes ?? [];
    if (!Array.isArray(nodes) || nodes.length === 0) {
      return null;
    }

    const candidates = nodes
      .map((node) => this.parseAxModeCandidate(node))
      .filter((value): value is { mode: DetectedMode; selected: boolean; label: string } => value !== null);

    if (candidates.length === 0) {
      return null;
    }

    const selected = candidates.find((candidate) => candidate.selected);
    if (selected) {
      return selected.mode;
    }

    return null;
  }

  private async readModeCandidatesFromAccessibility(client: ClientDomains): Promise<string[]> {
    const tree = await client.Accessibility?.getFullAXTree?.();
    const nodes = tree?.nodes ?? [];
    if (!Array.isArray(nodes) || nodes.length === 0) {
      return [];
    }

    const lines: string[] = [];
    for (const node of nodes) {
      const parsed = this.parseAxModeCandidate(node);
      if (!parsed) {
        continue;
      }
      lines.push(`${parsed.selected ? "[*]" : "[ ]"} [AX] ${parsed.label}`);
      if (lines.length >= 30) {
        break;
      }
    }
    return lines;
  }

  private parseAxModeCandidate(node: unknown): { mode: DetectedMode; selected: boolean; label: string } | null {
    if (!node || typeof node !== "object") {
      return null;
    }

    const maybe = node as {
      role?: { value?: string };
      name?: { value?: string };
      properties?: Array<{ name?: string; value?: { value?: unknown } }>;
    };
    const role = String(maybe.role?.value ?? "").toLowerCase();
    const label = String(maybe.name?.value ?? "").trim();
    if (!label || !/(^|\b)(agent|ask|debug|plan|code)(\b|$)/i.test(label)) {
      return null;
    }
    if (role && !/(button|menuitem|radio|tab|toggle)/i.test(role)) {
      return null;
    }

    const mode = this.modeFromText(label);
    if (!mode) {
      return null;
    }

    let selected = false;
    for (const property of maybe.properties ?? []) {
      const name = String(property.name ?? "").toLowerCase();
      const value = String(property.value?.value ?? "").toLowerCase();
      if ((name === "selected" || name === "checked" || name === "pressed") && value === "true") {
        selected = true;
      }
    }

    return { mode, selected, label };
  }

  private modeFromText(value: string): DetectedMode | null {
    const text = String(value || "").toLowerCase();
    if (/(^|\b)agent(\b|$)/.test(text)) return "Agent";
    if (/(^|\b)ask(\b|$)/.test(text)) return "Ask";
    if (/(^|\b)debug(\b|$)/.test(text)) return "Debug";
    if (/(^|\b)plan(\b|$)/.test(text)) return "Plan";
    if (/(^|\b)code(\b|$)/.test(text)) return "Code";
    return null;
  }

  private async detectCurrentModel(client: ClientDomains): Promise<string | null> {
    const modelSelectorLiteral = JSON.stringify(config.cursorModelSelector);
    const expression = `
      (() => {
        const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
        const isVisible = (el) => {
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 3 && rect.height > 3 && style.visibility !== 'hidden' && style.display !== 'none';
        };

        // 1. Try configured model selector
        const configured = ${modelSelectorLiteral};
        if (configured) {
          const matches = Array.from(document.querySelectorAll(configured)).filter(isVisible);
          for (const el of matches) {
            const text = normalize(el.textContent || '');
            if (text && text.length < 80) return text;
          }
        }

        // 2. Fallback: look for known Cursor model display classes
        const fallbackSelectors = [
          '[class*="model-name-display"]',
          '[class*="composer-unified-dropdown-model"]',
          '[class*="bc-instance-header-model"]'
        ];
        for (const sel of fallbackSelectors) {
          const matches = Array.from(document.querySelectorAll(sel)).filter(isVisible);
          for (const el of matches) {
            const text = normalize(el.textContent || '');
            if (text && text.length < 80) return text;
          }
        }

        return null;
      })();
    `;
    return await this.cdp.evaluateJson<string | null>(client, expression);
  }

  private async clickModelOption(
    client: ClientDomains,
    targetModel: string
  ): Promise<{ ok: boolean; selectedModel: string | null }> {
    const modelSelectorLiteral = JSON.stringify(config.cursorModelSelector);
    const targetModelLiteral = JSON.stringify(targetModel.toLowerCase());
    const expression = `
      (() => {
        const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
        const lower = (value) => normalize(value).toLowerCase();
        const isVisible = (el) => {
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 3 && rect.height > 3 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const target = ${targetModelLiteral};

        // Find the model dropdown trigger
        const configured = ${modelSelectorLiteral};
        const dropdownSelectors = configured
          ? [configured, '[class*="model-name-display"]', '[class*="composer-unified-dropdown-model"]']
          : ['[class*="model-name-display"]', '[class*="composer-unified-dropdown-model"]'];

        let dropdownEl = null;
        for (const sel of dropdownSelectors) {
          const matches = Array.from(document.querySelectorAll(sel)).filter(isVisible);
          if (matches.length > 0) {
            dropdownEl = matches[0];
            break;
          }
        }
        if (!dropdownEl) return { ok: false, selectedModel: null };

        // Check if already on the target model
        const currentText = lower(dropdownEl.textContent || '');
        if (currentText.includes(target)) {
          return { ok: true, selectedModel: normalize(dropdownEl.textContent || '') };
        }

        // Click to open the dropdown
        const clickTarget = dropdownEl.closest('button,[role="button"]') || dropdownEl;
        clickTarget.click();

        // Search for matching option in the opened menu
        const dr = clickTarget.getBoundingClientRect();
        const optionNodes = Array.from(
          document.querySelectorAll('button,[role="button"],[role="menuitem"],[role="option"],div,span,a,li')
        ).filter(isVisible);

        const scored = optionNodes
          .map((el) => {
            const text = lower(el.textContent || '');
            if (text.length > 80 || text.length < 2) return null;
            const er = el.getBoundingClientRect();
            const near = Math.abs(er.left - dr.left) <= 500 && Math.abs(er.top - dr.top) <= 600;
            if (!near) return null;
            // Score: exact match > includes > partial
            let score = 0;
            if (text === target) score = 100;
            else if (text.includes(target)) score = 80;
            else if (target.split(/[\\s-]+/).every(part => text.includes(part))) score = 60;
            else return null;
            return { el, text, score };
          })
          .filter(Boolean)
          .sort((a, b) => b.score - a.score);

        if (scored.length > 0) {
          scored[0].el.click();
          return { ok: true, selectedModel: normalize(scored[0].el.textContent || '') };
        }

        // Close dropdown if nothing matched (click away or press Escape)
        document.body.click();
        return { ok: false, selectedModel: normalize(dropdownEl.textContent || '') };
      })();
    `;
    const result = await this.cdp.evaluateJson<{ ok: boolean; selectedModel: string | null }>(client, expression);
    return result ?? { ok: false, selectedModel: null };
  }

  private async injectPromptText(client: ClientDomains, prompt: string): Promise<boolean> {
    const escapedPrompt = JSON.stringify(prompt);
    const expression = `
      (() => {
        const el = document.activeElement;
        if (!el) return false;
        const text = ${escapedPrompt};

        if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
          el.value = text;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }

        if (el.getAttribute && el.getAttribute('contenteditable') === 'true') {
          el.textContent = text;
          el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
          return true;
        }

        return false;
      })();
    `;
    const injected = await this.cdp.evaluateJson<boolean>(client, expression);
    return injected === true;
  }

  private async waitForCurrentTurn(
    client: ClientDomains,
    options: {
      maxWaitMs: number;
      baselineSnippet: string | null;
      prompt?: string;
      onProgress?: (event: AgentProgressEvent) => void | Promise<void>;
      signal?: AbortSignal;
    }
  ): Promise<string | null> {
    const deadline = Date.now() + Math.max(5_000, options.maxWaitMs);
    let lastStatus = "";
    let lastMarkdown = "";
    let stableAt = 0;

    while (Date.now() < deadline) {
      if (options.signal?.aborted) {
        return "__cancelled__";
      }
      const snapshot = await this.readTurnSnapshot(client);
      const statusKind = this.progressKind(snapshot.statusText);
      if (statusKind && statusKind !== lastStatus) {
        lastStatus = statusKind;
        if (options.onProgress) {
          await options.onProgress({
            phase: statusKind === "thinking" ? "thinking" : statusKind === "waiting" ? "waiting" : "working",
            text: statusKind === "thinking" ? "思考中" : statusKind === "waiting" ? "等待中" : "执行中"
          });
        }
      }

      const markdown = snapshot.markdown?.trim() ? snapshot.markdown.trim() : "";
      const isNew =
        Boolean(markdown) &&
        markdown !== options.baselineSnippet &&
        !this.isPromptEcho(markdown, options.prompt ?? "") &&
        !this.isActivitySnippet(markdown);

      if (isNew) {
        if (markdown !== lastMarkdown) {
          lastMarkdown = markdown;
          stableAt = Date.now();
          if (options.onProgress) {
            await options.onProgress({
              phase: "working",
              text: markdown,
              content: markdown
            });
          }
        } else {
          if (stableAt === 0) {
            stableAt = Date.now();
          }
          if (!snapshot.generating && Date.now() - stableAt >= 2000) {
            logger.info({ chars: markdown.length }, "Cursor turn captured after generation settled");
            return markdown;
          }
        }
      }
      await wait(options.onProgress ? 500 : 800);
    }

    return lastMarkdown && lastMarkdown !== options.baselineSnippet ? lastMarkdown : null;
  }

  private progressKind(statusText: string): "thinking" | "waiting" | "working" | null {
    const compact = statusText.replace(/\s+/g, " ").trim();
    if (!compact) {
      return null;
    }
    if (/thought|thinking/i.test(compact)) {
      return "thinking";
    }
    if (/waited|waiting|worked for/i.test(compact)) {
      return "waiting";
    }
    if (/explor|reading|searching|running|edited|called/i.test(compact)) {
      return "working";
    }
    return null;
  }

  private async readTurnSnapshot(client: ClientDomains): Promise<{
    generating: boolean;
    statusText: string;
    markdown: string;
  }> {
    const expression = `
      (() => {
        function getNodeText(node) {
          if (!node) return '';
          const inner = typeof node.innerText === 'string' ? node.innerText : '';
          const text = typeof node.textContent === 'string' ? node.textContent : '';
          return inner && inner.trim().length > 0 ? inner : text;
        }
        function sanitize(text) {
          return String(text || '').replace(/\\r\\n/g, '\\n').trim();
        }
        const rows = Array.from(document.querySelectorAll('.virtualized-composer-messages-row'));
        const items = rows.map((el) => {
          const inner = el.querySelector('[data-react-transcript-row-kind],[data-message-kind],[data-tool-status]');
          return {
            key: String(el.getAttribute('data-find-row-key') || el.getAttribute('data-react-transcript-row-key') || ''),
            kind: String((inner && inner.getAttribute('data-react-transcript-row-kind')) || ''),
            messageKind: String((inner && inner.getAttribute('data-message-kind')) || ''),
            toolStatus: String((inner && inner.getAttribute('data-tool-status')) || ''),
            pairIndex: String(el.getAttribute('data-pair-index') || ''),
            text: sanitize(getNodeText(el))
          };
        });
        let lastHuman = -1;
        for (let i = items.length - 1; i >= 0; i -= 1) {
          if (/^human:/.test(items[i].key)) {
            lastHuman = i;
            break;
          }
        }
        const currentPair = lastHuman >= 0
          ? items[lastHuman].pairIndex
          : items.reduce((max, row) => {
              const n = Number(row.pairIndex);
              return Number.isFinite(n) && n > max ? n : max;
            }, -1);
        const turn = currentPair >= 0
          ? items.filter((row) => Number(row.pairIndex) === Number(currentPair) || (!row.pairIndex && /^(tail-status|synthetic|turn-actions):/.test(row.key)))
          : lastHuman >= 0 ? items.slice(lastHuman + 1) : items.slice(-16);
        const status = [];
        const markdown = [];
        for (const row of turn) {
          const key = row.key;
          const firstLine = (row.text.split('\\n').find((line) => line.trim()) || '').trim();
          if (row.kind === 'tailStatus' || /^tail-status:/.test(key)) {
            if (firstLine) status.push(firstLine.slice(0, 240));
            continue;
          }
          if (row.kind === 'activityGroup' || row.kind === 'activity' || row.messageKind === 'thinking' || row.messageKind === 'tool' || /thinking|activity-group|work-group|tool-placeholder/.test(key)) {
            if (firstLine) status.push(firstLine.slice(0, 240));
            continue;
          }
          if ((row.kind === 'assistantMarkdown' || /assistant-markdown|assistantMarkdown/.test(key) || row.messageKind === 'assistant') && row.text) {
            markdown.push(row.text);
          }
        }
        const stop = Array.from(document.querySelectorAll('button,[role="button"]')).some((el) => {
          const label = String((el.getAttribute('aria-label') || '') + ' ' + (el.textContent || ''));
          const rect = el.getBoundingClientRect();
          return rect.width > 4 && rect.height > 4 && /stop generating|停止生成/i.test(label);
        });
        const liveTail = items.some((row) => row.kind === 'tailStatus' || /^tail-status:/.test(row.key));
        const toolLoading = items.some((row) => row.toolStatus === 'loading');
        const completed = turn.some((row) => /^turn-actions:/.test(row.key) || row.kind === 'turnActions');
        return {
          generating: stop || liveTail || toolLoading || !completed,
          statusText: status.length ? status[status.length - 1] : '',
          markdown: markdown.join('\\n\\n').slice(0, 24000)
        };
      })();
    `;
    const result = await this.cdp.evaluateJson<{ generating: boolean; statusText: string; markdown: string }>(
      client,
      expression
    );
    return {
      generating: result?.generating === true,
      statusText: result?.statusText ?? "",
      markdown: result?.markdown ?? ""
    };
  }

  private async pollLatestAssistantSnippet(
    client: ClientDomains,
    timeoutMs: number,
    baselineSnippet: string | null,
    prompt?: string
  ): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    const promptNorm = (prompt ?? "").trim();
    let lastValue: string | null = baselineSnippet;
    let changedAtMs: number | null = null;
    while (Date.now() < deadline) {
      const snippet = await this.readLatestAssistantSnippet(client);
      if (snippet && snippet !== baselineSnippet && !this.isPromptEcho(snippet, promptNorm) && !this.isActivitySnippet(snippet)) {
        if (snippet !== lastValue) {
          changedAtMs = Date.now();
        }
        lastValue = snippet;
        // Return once response changed and appears stable briefly.
        if (changedAtMs !== null && Date.now() - changedAtMs >= 1200) {
          return lastValue;
        }
      }
      await wait(300);
    }
    return lastValue && lastValue !== baselineSnippet && !this.isPromptEcho(lastValue, promptNorm) && !this.isActivitySnippet(lastValue)
      ? lastValue
      : null;
  }

  private isPromptEcho(snippet: string, prompt: string): boolean {
    if (!prompt) {
      return false;
    }
    const value = snippet.trim();
    if (value === prompt) {
      return true;
    }
    const firstLine = value.split("\n")[0]?.trim() ?? "";
    return firstLine === prompt && value.length <= prompt.length + 24;
  }

  private isActivitySnippet(snippet: string): boolean {
    const value = snippet.trim();
    if (!value) {
      return true;
    }
    const compact = value.replace(/\s+/g, " ");
    if (compact.length <= 120 && /^(worked for|thought|thinking|just now|generating|cursor grok|exploring|explored|reading|searching|running|edited|called|listed|planning|using|looking|considering|reviewed|scanned|grepping)/i.test(compact)) {
      return true;
    }
    if (/^\d+\s+files?$/i.test(compact) || /^exploring\s+\d+(\s+files?)?$/i.test(compact)) {
      return true;
    }
    return compact.length <= 80 && /exploring|files?|tool call|running command/i.test(compact) && !/[。！？.!?]$/.test(compact);
  }

  private async readLatestAssistantSnippet(client: ClientDomains): Promise<string | null> {
    const selectorLiteral = JSON.stringify(config.cursorResponseSelector);
    const expression = `
      (() => {
        function getNodeText(node) {
          if (!node) return '';
          const inner = typeof node.innerText === 'string' ? node.innerText : '';
          const text = typeof node.textContent === 'string' ? node.textContent : '';
          return inner && inner.trim().length > 0 ? inner : text;
        }

        function sanitize(text) {
          const raw = String(text || '').replace(/\\r\\n/g, '\\n');
          const lines = raw.split('\\n').map((line) => line.replace(/\\s+$/g, ''));
          const kept = [];
          let blankRun = 0;
          for (const line of lines) {
            if (line.trim().length === 0) {
              blankRun += 1;
              if (blankRun > 2) continue;
              kept.push('');
              continue;
            }
            blankRun = 0;
            kept.push(line);
          }
          return kept.join('\\n').trim();
        }

        function isHuman(el) {
          if (!el || !el.closest) return false;
          const host = el.closest('[data-message-role],[data-message-kind],.composer-human-message,.composer-human-message-container');
          if (!host) return false;
          const role = String(host.getAttribute('data-message-role') || '').toLowerCase();
          const kind = String(host.getAttribute('data-message-kind') || '').toLowerCase();
          if (role === 'human' || role === 'user') return true;
          if (kind === 'human' || kind === 'user') return true;
          const cls = String(host.className || '');
          return /composer-human-message|human-message/.test(cls);
        }

        function isStatusChrome(text) {
          const compact = String(text || '').replace(/\\s+/g, ' ').trim();
          return /^(worked for|thought|thinking|just now|generating|cursor grok|exploring|reading|searching|running|edited|called|listed|planning|using|looking|considering|reviewed|scanned|grepping)/i.test(compact)
            || /^\\d+\\s+files?$/i.test(compact)
            || /^exploring\\s+\\d+/i.test(compact);
        }

        function isActivityRow(el) {
          if (!el) return false;
          const kind = String(el.getAttribute('data-react-transcript-row-kind') || '').toLowerCase();
          if (kind && kind !== 'assistantmarkdown' && kind !== 'markdown') return true;
          const key = String(el.getAttribute('data-find-row-key') || el.getAttribute('data-react-transcript-row-key') || '');
          if (/work-group|activity-group|thinking|tool|turn-actions/i.test(key)) return true;
          const cls = String(el.className || '');
          return /activity|thinking|tool-call|work-group/.test(cls);
        }

        function pickText(el) {
          const md = el.querySelector('.anysphere-markdown-container-root, .agent-transcript-row-markdown, [class*="ui-markdown"], [class*="markdown"]');
          return sanitize(getNodeText(md || el));
        }

        const markdownRows = Array.from(document.querySelectorAll('[data-react-transcript-row-kind="assistantMarkdown"], .agent-transcript-row-markdown'));
        for (let i = markdownRows.length - 1; i >= 0; i -= 1) {
          const el = markdownRows[i];
          if (isHuman(el) || isActivityRow(el)) continue;
          const txt = pickText(el);
          if (txt && !isStatusChrome(txt)) return txt.slice(0, 3200);
        }

        const assistantHosts = Array.from(document.querySelectorAll(
          '[data-message-kind="assistant"], [data-message-role="ai"]'
        ));
        for (let i = assistantHosts.length - 1; i >= 0; i -= 1) {
          const el = assistantHosts[i];
          if (isHuman(el) || isActivityRow(el)) continue;
          const txt = pickText(el);
          if (txt && !isStatusChrome(txt)) return txt.slice(0, 3200);
        }

        const configured = ${selectorLiteral};
        if (configured) {
          const nodes = Array.from(document.querySelectorAll(configured));
          for (let i = nodes.length - 1; i >= 0; i -= 1) {
            if (isHuman(nodes[i]) || isActivityRow(nodes[i])) continue;
            const txt = sanitize(getNodeText(nodes[i]));
            if (txt && !isStatusChrome(txt)) return txt.slice(0, 3200);
          }
        }

        const preferredSelectors = [
          '.agent-transcript-row-markdown',
          '.anysphere-markdown-container-root',
          '[class*="assistant-message"]',
          '[data-testid*="assistant"]'
        ];
        for (const sel of preferredSelectors) {
          const nodes = Array.from(document.querySelectorAll(sel));
          for (let i = nodes.length - 1; i >= 0; i -= 1) {
            if (isHuman(nodes[i]) || isActivityRow(nodes[i])) continue;
            const txt = sanitize(getNodeText(nodes[i]));
            if (txt && !isStatusChrome(txt)) return txt.slice(0, 3200);
          }
        }
        return null;
      })();
    `;
    return await this.cdp.evaluateJson<string | null>(client, expression);
  }
}
