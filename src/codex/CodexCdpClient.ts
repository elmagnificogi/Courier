import { BaseCdpClient, CdpTargetSummary } from "../cdp/BaseCdpClient";
import { config } from "../config";

export class CodexCdpClient extends BaseCdpClient {
  constructor() {
    super({
      remoteDebugUrl: config.codexRemoteDebugUrl,
      targetTitleHint: config.codexTargetTitleHint
    });
  }

  protected override async scoreTarget(target: CdpTargetSummary): Promise<number> {
    let score = await super.scoreTarget(target);
    const url = String(target.url || "").toLowerCase();
    const title = String(target.title || "").toLowerCase();
    if (url.startsWith("app://")) score += 40;
    if (title.includes("codex") || title.includes("chatgpt")) score += 16;
    if (url.startsWith("http://") || url.startsWith("https://")) score -= 24;
    if (url.includes("devtools")) score -= 40;
    return score;
  }
}
