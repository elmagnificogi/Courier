import { BaseCdpClient, CdpTargetSummary } from "../cdp/BaseCdpClient";
import { config } from "../config";

function isCodexChatPage(target: CdpTargetSummary): boolean {
  const url = String(target.url || "").toLowerCase();
  if (target.type !== "page" || !url.startsWith("app://")) {
    return false;
  }
  if (url.includes("avatar-overlay") || url.includes("detached-window")) {
    return false;
  }
  return true;
}

export class CodexCdpClient extends BaseCdpClient {
  constructor() {
    super({
      remoteDebugUrl: config.codexRemoteDebugUrl,
      targetTitleHint: config.codexTargetTitleHint
    });
  }

  override async listPageTargets(): Promise<CdpTargetSummary[]> {
    const pages = await super.listPageTargets();
    return pages.filter((target) => isCodexChatPage(target));
  }

  protected override async scoreTarget(target: CdpTargetSummary): Promise<number> {
    let score = await super.scoreTarget(target);
    const url = String(target.url || "").toLowerCase();
    const title = String(target.title || "").toLowerCase();
    if (url.startsWith("app://")) score += 40;
    if (title.includes("codex") || title.includes("chatgpt")) score += 16;
    if (url.startsWith("http://") || url.startsWith("https://")) score -= 24;
    if (url.includes("devtools") || url.includes("avatar-overlay") || url.includes("detached-window")) score -= 40;
    return score;
  }
}
