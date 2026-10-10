import { config, ideDisplayName } from "../config";
import { ClientDomains, CdpTargetSummary, wait } from "../cdp/BaseCdpClient";
import { logger } from "../logger";
import { BridgeMode, BridgeResponse, SendPromptOptions } from "../types";
import { CodexCdpClient } from "./CodexCdpClient";

const IDE = "Codex";

export class CodexAutomationClient {
  private readonly cdp = new CodexCdpClient();

  async listChatTargets(): Promise<CdpTargetSummary[]> {
    try {
      return await this.cdp.listTargets();
    } catch (error) {
      logger.warn({ error }, "Failed to list Codex targets through CDP");
      return [];
    }
  }

  async targetSelectionStatus(): Promise<{ mode: "auto" | "manual"; manualTargetId: string | null; manualTargetTitle: string | null }> {
    try {
      return await this.cdp.getSelectionState();
    } catch (error) {
      logger.warn({ error }, "Failed to read Codex target selection state");
      return { mode: "auto", manualTargetId: null, manualTargetTitle: null };
    }
  }

  async selectTarget(selection: "auto" | number): Promise<BridgeResponse> {
    if (selection === "auto") {
      this.cdp.clearManualTarget();
      return { text: "目标选择已改回自动。", metadata: { target_mode: "auto" } };
    }
    const target = await this.cdp.setManualTargetByPageIndex(selection - 1);
    if (!target) {
      const pages = await this.cdp.listPageTargets();
      return {
        text: `目标序号 ${selection} 无效。用 /targets 查看（1-${pages.length}）。`,
        metadata: { target_mode: "manual", status: "invalid-index" }
      };
    }
    return {
      text: `已固定目标 #${selection}：${target.title || "（无标题）"}`,
      metadata: { target_mode: "manual", target_id: target.id, target_title: target.title }
    };
  }

  async setMode(mode: BridgeMode): Promise<BridgeResponse> {
    if (mode === "debug") {
      return { text: "Codex 没有 debug 模式。可用：ask、code、plan。", metadata: { status: "unsupported" } };
    }
    const label = mode === "ask" ? "Ask" : mode === "plan" ? "Plan" : "Agent";
    try {
      const changed = await this.cdp.withClient(async (client) => this.clickLabel(client, label));
      if (changed) {
        return { text: `已尝试把 Codex 切到 ${mode}（${label}）。`, metadata: { status: "unverified", mode } };
      }
      return {
        text: `没有在 Codex 界面上点到 ${label}。请保持对话窗口可见后重试。`,
        metadata: { status: "failed", mode }
      };
    } catch (error) {
      logger.warn({ error, mode }, "Codex mode switch failed");
      return { text: `Codex 模式切换失败（${mode}）。请确认调试端口可用。`, metadata: { status: "failed", mode } };
    }
  }

  async getModel(): Promise<BridgeResponse> {
    try {
      const model = await this.cdp.withClient(async (client) => this.readModelLabel(client));
      if (model) {
        return { text: `当前 Codex 模型：${model}`, metadata: { status: "detected", model } };
      }
      return { text: "没有读到 Codex 当前模型。请让模型菜单露出来后重试。", metadata: { status: "unverified" } };
    } catch (error) {
      logger.warn({ error }, "Codex model detection failed");
      return { text: "读取 Codex 模型失败。", metadata: { status: "failed" } };
    }
  }

  async setModel(modelName: string): Promise<BridgeResponse> {
    const desired = modelName.trim();
    if (!desired) {
      return { text: "请提供模型名：/model <名称>", metadata: { status: "invalid-args" } };
    }
    try {
      const changed = await this.cdp.withClient(async (client) => this.clickLabel(client, desired));
      if (!changed) {
        return {
          text: `没有在 Codex 界面上找到「${desired}」。请先打开模型菜单再发 /model。`,
          metadata: { status: "model-not-found", requested: desired }
        };
      }
      return { text: `已尝试把 Codex 模型切到 ${desired}，请在界面上确认。`, metadata: { status: "unverified", requested: desired } };
    } catch (error) {
      logger.warn({ error, modelName: desired }, "Codex model switch failed");
      return { text: `切换 Codex 模型失败（${desired}）。`, metadata: { status: "failed", requested: desired } };
    }
  }

  async listModels(): Promise<BridgeResponse> {
    try {
      const labels = await this.cdp.withClient(async (client) => this.readVisibleLabels(client));
      if (labels.length === 0) {
        return { text: "没有列出 Codex 模型。请打开模型菜单后再发 /models。", metadata: { status: "unverified" } };
      }
      return {
        text: ["Codex 界面上可见的选项：", ...labels.slice(0, 20).map((item, index) => `${index + 1}. ${item}`)].join("\n"),
        metadata: { status: "listed", count: labels.length }
      };
    } catch (error) {
      logger.warn({ error }, "Codex model list failed");
      return { text: "列出 Codex 模型失败。", metadata: { status: "failed" } };
    }
  }

  async newChat(): Promise<BridgeResponse> {
    try {
      const dispatched = await this.cdp.withClient(async (client) => {
        await this.cdp.sendShortcut(client, "n", "KeyN", 78, 2);
        await wait(300);
        return true;
      });
      if (dispatched) {
        return { text: "已向 Codex 发送新建对话快捷键（Ctrl+N）。请看窗口是否开了新线程。", metadata: { status: "unverified" } };
      }
      return { text: "没能让 Codex 新建对话。", metadata: { status: "failed" } };
    } catch (error) {
      logger.warn({ error }, "Codex new chat failed");
      return { text: "Codex 新建对话失败。请确认调试端口可用。", metadata: { status: "failed" } };
    }
  }

  async sendPrompt(prompt: string, options?: SendPromptOptions): Promise<BridgeResponse> {
    logger.info({ length: prompt.length }, "Codex prompt relay requested");
    const maxMs = options?.onProgress ? config.codexRelayMaxMs : config.codexActionTimeoutMs;
    try {
      const relay = await this.cdp.withClient(async (client) => {
        const focused = await this.focusComposer(client);
        if (!focused) {
          return { status: "failed-focus" as const, text: null as string | null };
        }
        const baseline = await this.readAssistant(client);
        await this.cdp.sendText(client, prompt);
        await this.pressEnter(client);
        const text = await this.pollAssistant(client, baseline, maxMs, options);
        return { status: "submitted" as const, text };
      });
      if (relay.status === "failed-focus") {
        return {
          text: "没能聚焦 Codex 输入框。请用 --remote-debugging-port 启动 Codex，并让当前对话窗口可见。",
          metadata: { status: "failed" }
        };
      }
      if (relay.text) {
        return { text: relay.text, metadata: { status: "delivered" } };
      }
      return {
        text: `提示已发给 ${IDE}，但还没有抓到完整回复。可以发 /last 再看一次。`,
        metadata: { status: "delivered-no-snippet" }
      };
    } catch (error) {
      logger.warn({ error }, "Codex prompt relay failed");
      return { text: "转发到 Codex 失败。请检查 CODEX_REMOTE_DEBUG_URL 和目标窗口。", metadata: { status: "failed" } };
    }
  }

  async latestAssistantSnippet(): Promise<string | null> {
    try {
      return await this.cdp.withClient(async (client) => this.readAssistant(client));
    } catch (error) {
      logger.warn({ error }, "Failed reading latest Codex assistant snippet");
      return null;
    }
  }

  async diagnostics(): Promise<{
    cdpReachable: boolean;
    versionEndpointReachable: boolean;
    targetCount: number;
    pageTargetCount: number;
    selectedTargetTitle: string | null;
    chatInputFocusable: boolean | null;
    detectedMode: string | null;
    configuredSelectors: { chatInput: string; response: string };
    targetSelection: { mode: "auto" | "manual"; manualTargetId: string | null; manualTargetTitle: string | null };
    notes: string[];
    selectorHealth: {
      configuredChatInputMatches: number;
      configuredResponseMatches: number;
      fallbackTextboxCandidates: number;
      fallbackResponseCandidates: number;
    };
  }> {
    const notes: string[] = [];
    const configuredSelectors = {
      chatInput: config.codexChatInputSelector,
      response: config.codexResponseSelector
    };
    let versionEndpointReachable = false;
    try {
      const version = await this.cdp.readVersionInfo();
      versionEndpointReachable = Boolean(version?.webSocketDebuggerUrl);
    } catch (error) {
      logger.warn({ error }, "Codex CDP version check failed");
      notes.push("版本接口检查失败。");
    }
    try {
      const targets = await this.cdp.listTargets();
      const pages = targets.filter((target) => target.type === "page");
      const selection = await this.cdp.getSelectionState();
      const probe = await this.cdp.withClient(async (client) => {
        const focusable = await this.focusComposer(client);
        const health = await this.selectorHealth(client);
        return { focusable, health };
      });
      return {
        cdpReachable: true,
        versionEndpointReachable,
        targetCount: targets.length,
        pageTargetCount: pages.length,
        selectedTargetTitle: selection.manualTargetTitle,
        chatInputFocusable: probe.focusable,
        detectedMode: null,
        configuredSelectors,
        targetSelection: selection,
        notes,
        selectorHealth: probe.health
      };
    } catch (error) {
      logger.warn({ error }, "Codex diagnostics probe failed");
      notes.push("CDP 探测失败。");
      return {
        cdpReachable: false,
        versionEndpointReachable,
        targetCount: 0,
        pageTargetCount: 0,
        selectedTargetTitle: null,
        chatInputFocusable: null,
        detectedMode: null,
        configuredSelectors,
        targetSelection: { mode: "auto", manualTargetId: null, manualTargetTitle: null },
        notes,
        selectorHealth: {
          configuredChatInputMatches: 0,
          configuredResponseMatches: 0,
          fallbackTextboxCandidates: 0,
          fallbackResponseCandidates: 0
        }
      };
    }
  }

  private async focusComposer(client: ClientDomains): Promise<boolean> {
    const selector = config.codexChatInputSelector;
    const expression = `(() => {
      const configured = ${JSON.stringify(selector)};
      const visible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 8 && rect.height > 8 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const score = (el, configuredHit) => {
        const text = String((el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('placeholder'))) || '') + ' ' + String(el.className || '');
        const lowered = text.toLowerCase();
        const rect = el.getBoundingClientRect();
        let value = configuredHit ? 80 : 0;
        if (lowered.includes('codex') || lowered.includes('composer') || lowered.includes('message') || lowered.includes('prompt')) value += 30;
        if (rect.top > window.innerHeight * 0.45) value += 24;
        if (lowered.includes('terminal') || lowered.includes('monaco')) value -= 80;
        return value;
      };
      const ranked = [];
      for (const el of Array.from(document.querySelectorAll(configured || 'textarea,[contenteditable="true"],[role="textbox"]'))) {
        if (!visible(el)) continue;
        ranked.push({ el, score: score(el, true) });
      }
      ranked.sort((a, b) => b.score - a.score);
      const best = ranked[0] && ranked[0].el;
      if (!best || typeof best.focus !== 'function') return false;
      best.focus();
      return true;
    })()`;
    return Boolean(await this.cdp.evaluateJson<boolean>(client, expression));
  }

  private async pressEnter(client: ClientDomains): Promise<void> {
    await client.Input.dispatchKeyEvent({
      type: "keyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13
    });
    await client.Input.dispatchKeyEvent({
      type: "keyUp",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13
    });
  }

  private async readAssistant(client: ClientDomains): Promise<string | null> {
    const selector = config.codexResponseSelector;
    const expression = `(() => {
      const configured = ${JSON.stringify(selector)};
      const nodes = Array.from(document.querySelectorAll(configured || '[class*="markdown"], article'));
      const text = nodes.map((node) => String(node.innerText || '').trim()).filter((value) => value.length > 0);
      if (text.length === 0) return null;
      return text[text.length - 1];
    })()`;
    const value = await this.cdp.evaluateJson<string | null>(client, expression);
    return value && value.trim() ? value.trim() : null;
  }

  private async pollAssistant(
    client: ClientDomains,
    baseline: string | null,
    maxMs: number,
    options?: SendPromptOptions
  ): Promise<string | null> {
    const started = Date.now();
    let latest = baseline;
    let lastChange = started;
    while (Date.now() - started < maxMs) {
      if (options?.signal?.aborted) {
        break;
      }
      await wait(1500);
      const snapshot = await this.readTurn(client);
      if (snapshot.text && snapshot.text !== latest) {
        latest = snapshot.text;
        lastChange = Date.now();
        if (options?.onProgress && latest !== baseline) {
          await options.onProgress({ phase: snapshot.generating ? "working" : "waiting", text: `${ideDisplayName()} 正在回复…`, content: latest });
        }
      }
      const changed = Boolean(latest && latest !== baseline);
      const quietFor = Date.now() - lastChange;
      if (changed && !snapshot.generating && quietFor > 6000) {
        break;
      }
      if (changed && !snapshot.generating && quietFor > 12000) {
        break;
      }
    }
    return latest && latest !== baseline ? latest : null;
  }

  private async readTurn(client: ClientDomains): Promise<{ text: string | null; generating: boolean }> {
    const text = await this.readAssistant(client);
    const generating = Boolean(
      await this.cdp.evaluateJson<boolean>(
        client,
        `(() => {
          const nodes = Array.from(document.querySelectorAll('button,[role="button"],[aria-label]'));
          return nodes.some((el) => /stop|停止|cancel generating/i.test(String(el.innerText || el.getAttribute('aria-label') || '')));
        })()`
      )
    );
    return { text, generating };
  }

  private async clickLabel(client: ClientDomains, label: string): Promise<boolean> {
    const expression = `(() => {
      const wanted = ${JSON.stringify(label.toLowerCase())};
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 3 && rect.height > 3;
      };
      const nodes = Array.from(document.querySelectorAll('button,[role="button"],[role="menuitem"],[role="option"]')).filter(visible);
      const hit = nodes.find((el) => String(el.innerText || el.getAttribute('aria-label') || '').toLowerCase().includes(wanted));
      if (!hit) return false;
      hit.click();
      return true;
    })()`;
    return Boolean(await this.cdp.evaluateJson<boolean>(client, expression));
  }

  private async readModelLabel(client: ClientDomains): Promise<string | null> {
    const expression = `(() => {
      const nodes = Array.from(document.querySelectorAll('button,[role="button"]'));
      const hit = nodes.find((el) => /gpt|codex|o[0-9]|claude|sonnet|composer/i.test(String(el.innerText || '')));
      return hit ? String(hit.innerText || '').trim() : null;
    })()`;
    const value = await this.cdp.evaluateJson<string | null>(client, expression);
    return value && value.trim() ? value.trim() : null;
  }

  private async readVisibleLabels(client: ClientDomains): Promise<string[]> {
    const expression = `(() => {
      return Array.from(document.querySelectorAll('[role="option"],[role="menuitem"],button'))
        .map((el) => String(el.innerText || '').trim())
        .filter((text) => text && text.length < 80)
        .slice(0, 20);
    })()`;
    return (await this.cdp.evaluateJson<string[]>(client, expression)) ?? [];
  }

  private async selectorHealth(client: ClientDomains): Promise<{
    configuredChatInputMatches: number;
    configuredResponseMatches: number;
    fallbackTextboxCandidates: number;
    fallbackResponseCandidates: number;
  }> {
    const expression = `(() => {
      const input = ${JSON.stringify(config.codexChatInputSelector)};
      const response = ${JSON.stringify(config.codexResponseSelector)};
      return {
        configuredChatInputMatches: document.querySelectorAll(input).length,
        configuredResponseMatches: document.querySelectorAll(response).length,
        fallbackTextboxCandidates: document.querySelectorAll('textarea,[contenteditable="true"],[role="textbox"]').length,
        fallbackResponseCandidates: document.querySelectorAll('[class*="markdown"], article').length
      };
    })()`;
    return (
      (await this.cdp.evaluateJson<{
        configuredChatInputMatches: number;
        configuredResponseMatches: number;
        fallbackTextboxCandidates: number;
        fallbackResponseCandidates: number;
      }>(client, expression)) ?? {
        configuredChatInputMatches: 0,
        configuredResponseMatches: 0,
        fallbackTextboxCandidates: 0,
        fallbackResponseCandidates: 0
      }
    );
  }
}
