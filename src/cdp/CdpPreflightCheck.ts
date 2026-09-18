import { BaseCdpClient, ClientDomains } from "./BaseCdpClient";
import { CursorCdpClient } from "../cursor/CursorCdpClient";
import { WindsurfCdpClient } from "../windsurf/WindsurfCdpClient";
import { VscodeCdpClient } from "../vscode/VscodeCdpClient";
import { config } from "../config";
import { logger } from "../logger";

export interface SelectorProbeResult {
  selector: string;
  matches: number;
  /** true if at least one match is visible in the viewport */
  hasVisible: boolean;
}

export interface DiscoveredCandidate {
  selector: string;
  tag: string;
  role: string | null;
  className: string;
  visible: boolean;
  score: number;
}

export interface PreflightReport {
  ide: "cursor" | "windsurf" | "vscode";
  cdpUrl: string;
  connectivity: {
    reachable: boolean;
    versionOk: boolean;
    userAgent: string | null;
    targetCount: number;
    pageTargetCount: number;
  };
  selectors: {
    chatInput: SelectorProbeResult;
    response: SelectorProbeResult;
    modeIndicator: SelectorProbeResult;
  };
  discovery: {
    chatInputCandidates: DiscoveredCandidate[];
    responseCandidates: DiscoveredCandidate[];
    modeIndicatorCandidates: DiscoveredCandidate[];
  };
  warnings: string[];
  suggestions: string[];
}

function createCdpClient(): BaseCdpClient {
  if (config.bridgeIdeTarget === "windsurf") return new WindsurfCdpClient();
  if (config.bridgeIdeTarget === "vscode") return new VscodeCdpClient();
  return new CursorCdpClient();
}

function getConfiguredSelectors(): { chatInput: string; response: string; mode: string } {
  if (config.bridgeIdeTarget === "windsurf") {
    return {
      chatInput: config.windsurfChatInputSelector,
      response: config.windsurfResponseSelector,
      mode: ""
    };
  }
  if (config.bridgeIdeTarget === "vscode") {
    return {
      chatInput: config.vscodeChatInputSelector,
      response: config.vscodeResponseSelector,
      mode: config.vscodeModeSelector
    };
  }
  return {
    chatInput: config.cursorChatInputSelector,
    response: config.cursorResponseSelector,
    mode: ""
  };
}

/**
 * Probes a CSS selector against the live DOM, returning match count and visibility.
 */
async function probeSelector(
  cdp: BaseCdpClient,
  client: ClientDomains,
  selector: string
): Promise<SelectorProbeResult> {
  if (!selector) {
    return { selector: "(empty)", matches: 0, hasVisible: false };
  }
  const result = await cdp.evaluateJson<{ matches: number; hasVisible: boolean }>(
    client,
    `(() => {
      try {
        const nodes = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
        const hasVisible = nodes.some(el => {
          const r = el.getBoundingClientRect();
          const s = window.getComputedStyle(el);
          return r.width > 3 && r.height > 3 && s.visibility !== 'hidden' && s.display !== 'none';
        });
        return { matches: nodes.length, hasVisible };
      } catch (e) {
        return { matches: -1, hasVisible: false };
      }
    })()`
  );
  return {
    selector,
    matches: result?.matches ?? -1,
    hasVisible: result?.hasVisible ?? false
  };
}

/**
 * Auto-discovers chat input candidates from the live DOM.
 */
async function discoverChatInputCandidates(
  cdp: BaseCdpClient,
  client: ClientDomains
): Promise<DiscoveredCandidate[]> {
  const raw = await cdp.evaluateJson<DiscoveredCandidate[]>(
    client,
    `(() => {
      const isVisible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el);
        return r.width > 3 && r.height > 3 && s.visibility !== 'hidden' && s.display !== 'none';
      };
      const candidates = [
        ...Array.from(document.querySelectorAll('[role="textbox"]')),
        ...Array.from(document.querySelectorAll('[contenteditable="true"]')),
        ...Array.from(document.querySelectorAll('textarea'))
      ];
      const seen = new Set();
      return candidates.filter(el => {
        if (seen.has(el)) return false;
        seen.add(el);
        return true;
      }).slice(0, 15).map(el => {
        const r = el.getBoundingClientRect();
        const vis = isVisible(el);
        const cls = String(el.className || '').replace(/\\s+/g, ' ').trim().substring(0, 150);
        const role = el.getAttribute('role');
        const tag = el.tagName.toLowerCase();
        let score = 0;
        if (vis) score += 100;
        if (role === 'textbox') score += 50;
        if (cls.includes('xterm')) score -= 500;
        if (el.closest('[class*="chat"]') || el.closest('[class*="cascade"]') || el.closest('[class*="ide-input"]')) score += 200;
        score += Math.min(80, Math.max(0, r.top));
        let selector = tag;
        if (role) selector += '[role="' + role + '"]';
        return { selector, tag, role, className: cls, visible: vis, score };
      }).sort((a, b) => b.score - a.score);
    })()`
  );
  return raw ?? [];
}

/**
 * Auto-discovers response container candidates from the live DOM.
 */
async function discoverResponseCandidates(
  cdp: BaseCdpClient,
  client: ClientDomains
): Promise<DiscoveredCandidate[]> {
  const raw = await cdp.evaluateJson<DiscoveredCandidate[]>(
    client,
    `(() => {
      const isVisible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el);
        return r.width > 3 && r.height > 3 && s.visibility !== 'hidden' && s.display !== 'none';
      };
      const selectors = [
        '[class*="prose"]',
        '[class*="markdown"]',
        '[class*="assistant"]',
        '[class*="message-block"]',
        '[class*="composer-rendered"]',
        '[class*="anysphere-markdown"]',
        'article',
        '[role="article"]'
      ];
      const nodes = Array.from(document.querySelectorAll(selectors.join(',')));
      const seen = new Set();
      return nodes.filter(el => {
        if (seen.has(el)) return false;
        seen.add(el);
        return true;
      }).slice(0, 15).map(el => {
        const vis = isVisible(el);
        const cls = String(el.className || '').replace(/\\s+/g, ' ').trim().substring(0, 150);
        const role = el.getAttribute('role');
        const tag = el.tagName.toLowerCase();
        const textLen = (el.textContent || '').length;
        let score = 0;
        if (vis) score += 100;
        if (textLen >= 20) score += 50;
        if (cls.includes('prose')) score += 80;
        if (cls.includes('markdown')) score += 60;
        if (cls.includes('assistant') || cls.includes('bot-color')) score += 100;
        let selector = tag;
        if (cls.includes('prose')) selector = '[class*="prose"]';
        else if (cls.includes('markdown')) selector = '[class*="markdown"]';
        return { selector, tag, role, className: cls, visible: vis, score };
      }).sort((a, b) => b.score - a.score);
    })()`
  );
  return raw ?? [];
}

/**
 * Auto-discovers mode indicator candidates from the live DOM.
 */
async function discoverModeIndicatorCandidates(
  cdp: BaseCdpClient,
  client: ClientDomains
): Promise<DiscoveredCandidate[]> {
  const modeKeywords = config.bridgeIdeTarget === "windsurf"
    ? "write|chat|plan"
    : config.bridgeIdeTarget === "vscode"
      ? "chat|ask|agent|edit|plan|debug|code"
    : "agent|code|ask|debug|plan";
  const raw = await cdp.evaluateJson<DiscoveredCandidate[]>(
    client,
    `(() => {
      const isVisible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el);
        return r.width > 3 && r.height > 3 && s.visibility !== 'hidden' && s.display !== 'none';
      };
      const modeRe = new RegExp('(^|\\\\b)(${modeKeywords})(\\\\b|$)', 'i');
      const elements = Array.from(document.querySelectorAll('button,[role="button"],[role="menuitem"],[data-state]'))
        .filter(isVisible)
        .filter(el => {
          const text = [el.textContent || '', el.getAttribute('aria-label') || ''].join(' ');
          return modeRe.test(text) && text.length < 60;
        });
      return elements.slice(0, 10).map(el => {
        const cls = String(el.className || '').replace(/\\s+/g, ' ').trim().substring(0, 150);
        const role = el.getAttribute('role');
        const tag = el.tagName.toLowerCase();
        const dataState = el.getAttribute('data-state');
        let score = 100;
        if (dataState) score += 50;
        if (role === 'menuitem') score += 30;
        let selector = tag;
        if (dataState !== null) selector += '[data-state]';
        return { selector, tag, role, className: cls, visible: true, score };
      }).sort((a, b) => b.score - a.score);
    })()`
  );
  return raw ?? [];
}

/**
 * Runs the full CDP preflight check for the configured IDE target.
 */
export async function runPreflightCheck(): Promise<PreflightReport> {
  const ide = config.bridgeIdeTarget as "cursor" | "windsurf" | "vscode";
  const cdpUrl =
    ide === "windsurf"
      ? config.windsurfRemoteDebugUrl
      : ide === "vscode"
        ? config.vscodeRemoteDebugUrl
        : config.cursorRemoteDebugUrl;
  const cdp = createCdpClient();
  const selectors = getConfiguredSelectors();
  const warnings: string[] = [];
  const suggestions: string[] = [];

  // --- Connectivity ---
  let reachable = false;
  let versionOk = false;
  let userAgent: string | null = null;
  let targetCount = 0;
  let pageTargetCount = 0;

  try {
    const version = await cdp.readVersionInfo();
    versionOk = Boolean(version?.webSocketDebuggerUrl);
    userAgent = version?.["User-Agent"] ?? null;
    if (!versionOk) {
      warnings.push("版本接口可达，但缺少 webSocketDebuggerUrl。");
    }
  } catch {
    warnings.push(`无法访问 CDP 版本接口 ${cdpUrl}/json/version。IDE 是否已用 --remote-debugging-port 启动？`);
    return {
      ide,
      cdpUrl,
      connectivity: { reachable: false, versionOk: false, userAgent: null, targetCount: 0, pageTargetCount: 0 },
      selectors: {
        chatInput: { selector: selectors.chatInput, matches: 0, hasVisible: false },
        response: { selector: selectors.response, matches: 0, hasVisible: false },
        modeIndicator: { selector: selectors.mode, matches: 0, hasVisible: false }
      },
      discovery: { chatInputCandidates: [], responseCandidates: [], modeIndicatorCandidates: [] },
      warnings,
      suggestions: [
        `请用带远程调试的方式启动 ${ide === "windsurf" ? "Windsurf" : ide === "vscode" ? "VS Code" : "Cursor"}：--remote-debugging-port=${ide === "windsurf" ? "9223" : ide === "vscode" ? "9224" : "9222"}`
      ]
    };
  }

  try {
    const targets = await cdp.listTargets();
    targetCount = targets.length;
    pageTargetCount = targets.filter(t => t.type === "page").length;
    reachable = targets.length > 0;
    if (pageTargetCount === 0) {
      warnings.push("没有找到页面目标。IDE 可能还没有可见窗口。");
    }
  } catch {
    warnings.push("获取 CDP 目标列表失败。");
  }

  if (!reachable) {
    return {
      ide,
      cdpUrl,
      connectivity: { reachable, versionOk, userAgent, targetCount, pageTargetCount },
      selectors: {
        chatInput: { selector: selectors.chatInput, matches: 0, hasVisible: false },
        response: { selector: selectors.response, matches: 0, hasVisible: false },
        modeIndicator: { selector: selectors.mode, matches: 0, hasVisible: false }
      },
      discovery: { chatInputCandidates: [], responseCandidates: [], modeIndicatorCandidates: [] },
      warnings,
      suggestions
    };
  }

  // --- Selector validation + discovery ---
  let chatInputProbe: SelectorProbeResult = { selector: selectors.chatInput, matches: 0, hasVisible: false };
  let responseProbe: SelectorProbeResult = { selector: selectors.response, matches: 0, hasVisible: false };
  let modeProbe: SelectorProbeResult = { selector: selectors.mode, matches: 0, hasVisible: false };
  let chatInputCandidates: DiscoveredCandidate[] = [];
  let responseCandidates: DiscoveredCandidate[] = [];
  let modeIndicatorCandidates: DiscoveredCandidate[] = [];

  try {
    await cdp.withClient(async (client) => {
      // Probe configured selectors
      chatInputProbe = await probeSelector(cdp, client, selectors.chatInput);
      responseProbe = await probeSelector(cdp, client, selectors.response);
      if (selectors.mode) {
        modeProbe = await probeSelector(cdp, client, selectors.mode);
      }

      // Auto-discover candidates
      chatInputCandidates = await discoverChatInputCandidates(cdp, client);
      responseCandidates = await discoverResponseCandidates(cdp, client);
      modeIndicatorCandidates = await discoverModeIndicatorCandidates(cdp, client);
    });
  } catch {
    warnings.push("探测选择器时 CDP 执行失败。");
  }

  // --- Analyze results and generate warnings/suggestions ---
  if (chatInputProbe.matches === 0 || !chatInputProbe.hasVisible) {
    warnings.push(`聊天输入选择器 "${selectors.chatInput}" 匹配到 ${chatInputProbe.matches} 个元素（${chatInputProbe.hasVisible ? "可见" : "均不可见"}）。`);
    const best = chatInputCandidates.find(c => c.visible && c.score > 0);
    if (best) {
      suggestions.push(`建议的聊天输入选择器：${best.selector}（class="${best.className.substring(0, 80)}"）`);
    } else {
      suggestions.push("没有发现可见的聊天输入框。请确认 Cascade/Composer 面板已打开。");
    }
  }

  if (responseProbe.matches === 0) {
    // Response selector having 0 matches is only a warning if there are no messages yet
    const hasAnyResponses = responseCandidates.some(c => c.visible);
    if (hasAnyResponses) {
      warnings.push(`回复选择器 "${selectors.response}" 匹配到 0 个元素，但 DOM 里有类似回复的节点。`);
      const best = responseCandidates.find(c => c.visible && c.score > 50);
      if (best) {
        suggestions.push(`建议的回复选择器：${best.selector}（class="${best.className.substring(0, 80)}"）`);
      }
    }
  } else if (responseProbe.matches === -1) {
    warnings.push(`回复选择器 "${selectors.response}" 不是合法 CSS。`);
  }

  if (modeIndicatorCandidates.length === 0) {
    warnings.push("没有找到模式指示元素，模式切换可能不可用。");
  }

  return {
    ide,
    cdpUrl,
    connectivity: { reachable, versionOk, userAgent, targetCount, pageTargetCount },
    selectors: {
      chatInput: chatInputProbe,
      response: responseProbe,
      modeIndicator: modeProbe
    },
    discovery: { chatInputCandidates, responseCandidates, modeIndicatorCandidates },
    warnings,
    suggestions
  };
}

/**
 * Formats a preflight report as a human-readable string.
 */
export function formatPreflightReport(report: PreflightReport): string {
  const ideName = report.ide === "windsurf" ? "Windsurf" : report.ide === "vscode" ? "VS Code" : "Cursor";
  const lines: string[] = [];

  lines.push(`=== CDP 预检：${ideName} ===`);
  lines.push(`CDP 地址：${report.cdpUrl}`);
  lines.push("");

  // Connectivity
  lines.push("--- 连通性 ---");
  lines.push(`  可达：         ${report.connectivity.reachable ? "是" : "否"}`);
  lines.push(`  版本接口：     ${report.connectivity.versionOk ? "正常" : "异常"}`);
  lines.push(`  User-Agent：   ${report.connectivity.userAgent ?? "（未知）"}`);
  lines.push(`  目标：         共 ${report.connectivity.targetCount} 个，页面 ${report.connectivity.pageTargetCount} 个`);
  lines.push("");

  // Selector health
  lines.push("--- 已配置选择器 ---");
  const fmtProbe = (label: string, p: SelectorProbeResult) => {
    const status = p.matches > 0 && p.hasVisible ? "正常" : p.matches > 0 ? "隐藏" : p.matches === -1 ? "非法" : "失效";
    return `  ${label}: ${status}（${p.matches} 处匹配，可见=${p.hasVisible}）→ ${p.selector}`;
  };
  lines.push(fmtProbe("聊天输入", report.selectors.chatInput));
  lines.push(fmtProbe("回复区域", report.selectors.response));
  if (report.selectors.modeIndicator.selector) {
    lines.push(fmtProbe("模式指示", report.selectors.modeIndicator));
  }
  lines.push("");

  // Discovery
  if (report.discovery.chatInputCandidates.length > 0) {
    lines.push("--- 发现的聊天输入候选 ---");
    for (const c of report.discovery.chatInputCandidates.slice(0, 5)) {
      lines.push(`  [${c.visible ? "可见" : "隐藏"}] score=${c.score} ${c.selector} class="${c.className.substring(0, 60)}"`);
    }
    lines.push("");
  }

  if (report.discovery.responseCandidates.length > 0) {
    lines.push("--- 发现的回复区域候选 ---");
    for (const c of report.discovery.responseCandidates.slice(0, 5)) {
      lines.push(`  [${c.visible ? "可见" : "隐藏"}] score=${c.score} ${c.selector} class="${c.className.substring(0, 60)}"`);
    }
    lines.push("");
  }

  if (report.discovery.modeIndicatorCandidates.length > 0) {
    lines.push("--- 发现的模式指示候选 ---");
    for (const c of report.discovery.modeIndicatorCandidates.slice(0, 5)) {
      lines.push(`  [${c.visible ? "可见" : "隐藏"}] score=${c.score} ${c.selector} class="${c.className.substring(0, 60)}"`);
    }
    lines.push("");
  }

  // Warnings
  if (report.warnings.length > 0) {
    lines.push("--- 警告 ---");
    for (const w of report.warnings) {
      lines.push(`  ⚠ ${w}`);
    }
    lines.push("");
  }

  // Suggestions
  if (report.suggestions.length > 0) {
    lines.push("--- 建议 ---");
    for (const s of report.suggestions) {
      lines.push(`  → ${s}`);
    }
    lines.push("");
  }

  if (report.warnings.length === 0 && report.connectivity.reachable) {
    lines.push("全部检查通过，桥接可以正常使用。");
  }

  return lines.join("\n");
}

/**
 * Extracts a short IDE version string from the User-Agent header.
 * e.g. "Cursor/0.48.7 ..." → "v0.48.7", "Windsurf/1.108.2 ..." → "v1.108.2"
 */
function extractIdeVersion(userAgent: string | null, ide: string): string | null {
  if (!userAgent) return null;
  const versionToken = ide === "VS Code" ? "Code" : ide;
  const pattern = new RegExp(`${versionToken}/(\\d[\\d.]+)`, "i");
  const match = userAgent.match(pattern);
  return match?.[1] ? `v${match[1]}` : null;
}

/**
 * Builds a compact, self-healing user-facing alert from a preflight report.
 * Each failure type includes a likely cause and actionable quick-fix.
 * Returns null if there are no issues worth reporting.
 */
function buildPreflightAlert(report: PreflightReport): string | null {
  const ideName = report.ide === "windsurf" ? "Windsurf" : report.ide === "vscode" ? "VS Code" : "Cursor";
  const version = extractIdeVersion(report.connectivity.userAgent, ideName);
  const versionTag = version ? ` ${version}` : "";
  const debugPort = report.ide === "windsurf" ? "9223" : report.ide === "vscode" ? "9224" : "9222";
  const lines: string[] = [];

  // --- CDP unreachable ---
  if (!report.connectivity.reachable) {
    lines.push(`⚠️ 桥接告警（${ideName}）：无法连接 CDP ${report.cdpUrl}`);
    lines.push(`可能原因：${ideName} 未运行，或启动时没有加 --remote-debugging-port。`);
    lines.push(`处理办法：用带远程调试的方式重新打开 ${ideName}：--remote-debugging-port=${debugPort}`);
    if (report.ide === "cursor") {
      lines.push(`  若 Windsurf 占用了同一端口也会冲突。`);
    }
    return lines.join("\n");
  }

  // --- Version endpoint issues ---
  if (!report.connectivity.versionOk) {
    lines.push(`⚠️ 桥接告警（${ideName}${versionTag}）：CDP 版本接口返回了异常数据。`);
    lines.push(`可能原因：${ideName} 更新改了调试协议，或中间有代理干扰。`);
    lines.push(`处理办法：确认 ${report.cdpUrl}/json/version 能返回带 webSocketDebuggerUrl 的 JSON。`);
  }

  // --- No page targets ---
  if (report.connectivity.reachable && report.connectivity.pageTargetCount === 0) {
    lines.push(`⚠️ 桥接告警（${ideName}${versionTag}）：没有找到页面目标。`);
    lines.push(`可能原因：${ideName} 窗口还没加载完，或没有打开工作区/文件夹。`);
    const panelName = report.ide === "windsurf" ? "Cascade" : report.ide === "vscode" ? "Chat" : "Composer";
    lines.push(`处理办法：在 ${ideName} 里打开一个文件夹，并确保 ${panelName} 面板可见。`);
  }

  const suppressSelectorAlerts = report.ide === "cursor";

  // --- Chat input selector broken ---
  const ci = report.selectors.chatInput;
  if (!suppressSelectorAlerts && report.connectivity.reachable && report.connectivity.pageTargetCount > 0) {
    if (ci.matches === 0 || !ci.hasVisible) {
      const statusWord = ci.matches === 0 ? "无匹配" : `${ci.matches} 处匹配但都不可见`;
      lines.push(`⚠️ 桥接告警（${ideName}${versionTag}）：CHAT_INPUT 选择器失败（${statusWord}）。`);
      const panelName = report.ide === "windsurf" ? "Cascade" : report.ide === "vscode" ? "Chat" : "Composer";
      lines.push(`可能原因：${ideName}${versionTag} 更新改了 ${panelName} 布局。`);
      const bestInput = report.discovery.chatInputCandidates.find(c => c.visible && c.score > 0);
      if (bestInput) {
        lines.push(`自动发现："${bestInput.selector}"（class="${bestInput.className.substring(0, 60)}"，score=${bestInput.score}）`);
        const envVar =
          report.ide === "windsurf"
            ? "WINDSURF_CHAT_INPUT_SELECTOR"
            : report.ide === "vscode"
              ? "VSCODE_CHAT_INPUT_SELECTOR"
              : "CURSOR_CHAT_INPUT_SELECTOR";
        lines.push(`处理办法：在 .env 更新 ${envVar}，或发送 /diag 查看全部候选。`);
      } else if (ci.matches === 0) {
        const panelNameInner = report.ide === "windsurf" ? "Cascade" : report.ide === "vscode" ? "Chat" : "Composer";
        lines.push(`处理办法：打开 ${panelNameInner} 面板，然后发送 /diag 发现新选择器。`);
      } else {
        lines.push(`处理办法：面板可能被收起或滚走了。点一下它再发送 /diag。`);
      }
    } else if (ci.matches === -1) {
      lines.push(`⚠️ 桥接告警（${ideName}${versionTag}）：CHAT_INPUT 选择器不是合法 CSS。`);
      lines.push(`处理办法：检查 .env 里的选择器语法，然后发送 /diag。`);
    }
  }

  // --- Response selector broken ---
  const rs = report.selectors.response;
  if (!suppressSelectorAlerts && report.connectivity.reachable && report.connectivity.pageTargetCount > 0 && rs.matches === -1) {
    lines.push(`⚠️ 桥接告警（${ideName}${versionTag}）：RESPONSE 选择器不是合法 CSS。`);
    lines.push(`处理办法：检查 .env 里回复选择器的语法。`);
  } else if (!suppressSelectorAlerts && report.connectivity.reachable && report.connectivity.pageTargetCount > 0 && rs.matches === 0) {
    const hasResponseNodes = report.discovery.responseCandidates.some(c => c.visible);
    if (hasResponseNodes) {
      lines.push(`⚠️ 桥接告警（${ideName}${versionTag}）：RESPONSE 选择器匹配到 0 个元素，但 DOM 里有类似回复的节点。`);
      lines.push(`可能原因：${ideName}${versionTag} 更新改了消息渲染的 class。`);
      const bestResp = report.discovery.responseCandidates.find(c => c.visible && c.score > 50);
      if (bestResp) {
        lines.push(`自动发现："${bestResp.selector}"（class="${bestResp.className.substring(0, 60)}"，score=${bestResp.score}）`);
        const envVar =
          report.ide === "windsurf"
            ? "WINDSURF_RESPONSE_SELECTOR"
            : report.ide === "vscode"
              ? "VSCODE_RESPONSE_SELECTOR"
              : "CURSOR_RESPONSE_SELECTOR";
        lines.push(`处理办法：在 .env 更新 ${envVar}，或发送 /diag 查看全部候选。`);
      }
    }
  }

  // --- Mode indicator missing ---
  if (!suppressSelectorAlerts && report.connectivity.reachable && report.connectivity.pageTargetCount > 0 && report.discovery.modeIndicatorCandidates.length === 0) {
    lines.push(`⚠️ 桥接告警（${ideName}${versionTag}）：没有找到模式指示元素。`);
    lines.push(`可能原因：${ideName}${versionTag} 更新改了模式切换 UI，或面板被收起。`);
    const panelName = report.ide === "windsurf" ? "Cascade" : report.ide === "vscode" ? "Chat" : "Composer";
    lines.push(`处理办法：把 ${panelName} 面板完全打开。在修好之前 /mode 可能不可用。`);
  }

  if (lines.length === 0) {
    return null;
  }

  // Append a footer with the run-/diag reminder
  lines.push("");
  lines.push(`随时发送 /diag 可查看完整诊断和自动发现的选择器候选。`);

  return lines.join("\n");
}

/**
 * Runs preflight check and logs results. Non-blocking — always resolves.
 * Returns true if critical checks pass (CDP reachable + chat input selector valid).
 * If notifyUsers is provided, sends a compact alert to users when issues are found.
 */
export async function runStartupPreflightCheck(
  notifyUsers?: (message: string) => Promise<void>
): Promise<boolean> {
  try {
    const report = await runPreflightCheck();
    const ideName = report.ide === "windsurf" ? "Windsurf" : report.ide === "vscode" ? "VS Code" : "Cursor";

    if (!report.connectivity.reachable) {
      logger.warn(
        { ide: report.ide, cdpUrl: report.cdpUrl },
        `CDP preflight: ${ideName} is NOT reachable. Bridge will fail until IDE is launched with remote debugging.`
      );
      for (const s of report.suggestions) {
        logger.warn(`  → ${s}`);
      }
    } else if (report.warnings.length > 0) {
      logger.warn(
        { ide: report.ide, warnings: report.warnings.length },
        `CDP preflight: ${ideName} reachable but ${report.warnings.length} warning(s) found`
      );
      for (const w of report.warnings) {
        logger.warn(`  ⚠ ${w}`);
      }
      for (const s of report.suggestions) {
        logger.info(`  → ${s}`);
      }
    } else {
      logger.info(
        {
          ide: report.ide,
          targets: report.connectivity.targetCount,
          chatInputOk: report.selectors.chatInput.hasVisible,
          userAgent: report.connectivity.userAgent
        },
        `CDP preflight: ${ideName} all checks passed`
      );
    }

    // Notify users about issues via messaging platform
    const alert = buildPreflightAlert(report);
    if (alert && notifyUsers) {
      try {
        await notifyUsers(alert);
      } catch (notifyError) {
        logger.warn({ error: notifyError }, "Failed to send preflight alert to users");
      }
    }

    const chatOk = report.selectors.chatInput.matches > 0 && report.selectors.chatInput.hasVisible;
    return chatOk;
  } catch (error) {
    logger.warn({ error }, "CDP preflight check failed unexpectedly — bridge will attempt to run anyway");
    if (notifyUsers) {
      try {
        await notifyUsers("CDP 预检意外失败，请查看 Courier 日志。");
      } catch { /* best-effort */ }
    }
    return false;
  }
}
