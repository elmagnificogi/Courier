export interface PromptPolicyResult {
  allowed: boolean;
  reason?: string;
}

export class TextSecurityGuard {
  private static readonly EXFIL_PATTERNS: RegExp[] = [
    /\b(send|share|dump|export|post|upload|paste)\b[\s\S]{0,80}\b(cookie|cookies|session|localstorage|token|api[_ -]?key|secret|password|credential|env|\.env)\b/i,
    /\b(document\.cookie|localstorage|getitem\(|process\.env|aws_access_key_id|aws_secret_access_key)\b/i,
    /\bcopy\b[\s\S]{0,60}\b(all|entire)\b[\s\S]{0,60}\b(env|secrets?|cookies?)\b/i
  ];

  private static readonly REDACTION_RULES: Array<{ pattern: RegExp; replacement: string }> = [
    {
      pattern: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
      replacement: "[REDACTED_TOKEN]"
    },
    {
      pattern: /\b(sk-|ghp_|gho_|github_pat_|xox[baprs]-|AIza)[A-Za-z0-9_-]{8,}\b/g,
      replacement: "[REDACTED_TOKEN]"
    },
    {
      pattern: /\b(cookie|set-cookie)\s*[:=]\s*[^;\n]+/gi,
      replacement: "$1=[REDACTED]"
    },
    {
      pattern: /\b([A-Z0-9_]{2,})\s*=\s*([^\s"'`]{6,})/g,
      replacement: "$1=[REDACTED]"
    },
    {
      pattern: /\b(authorization\s*:\s*bearer)\s+[^\s]+/gi,
      replacement: "$1 [REDACTED]"
    }
  ];

  static evaluatePrompt(text: string): PromptPolicyResult {
    const value = String(text || "");
    for (const pattern of this.EXFIL_PATTERNS) {
      if (pattern.test(value)) {
        return {
          allowed: false,
          reason: "已被安全策略拦截：请求可能在尝试导出 cookie、token 或密钥。"
        };
      }
    }
    return { allowed: true };
  }

  static sanitizeOutbound(text: string): string {
    let value = String(text || "");
    for (const rule of this.REDACTION_RULES) {
      value = value.replace(rule.pattern, rule.replacement);
    }
    return value;
  }
}

