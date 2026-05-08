export interface RedactionRule {
  name: string;
  pattern: RegExp;
  replacement?: string;
}

export interface RedactionOptions {
  email?: boolean;
  phone?: boolean;
  secrets?: boolean;
  rules?: ReadonlyArray<RedactionRule>;
}

const EMAIL_RULE: RedactionRule = {
  name: "email",
  pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  replacement: "[redacted:email]",
};

const PHONE_RULE: RedactionRule = {
  name: "phone",
  pattern: /(?<!\d)\+?\d(?:[\d\s().-]{6,18})\d(?!\d)/g,
  replacement: "[redacted:phone]",
};

const SECRET_RULES: ReadonlyArray<RedactionRule> = [
  {
    name: "github-token",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
    replacement: "[redacted:github-token]",
  },
  {
    name: "openai-key",
    pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g,
    replacement: "[redacted:openai-key]",
  },
  {
    name: "anthropic-key",
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
    replacement: "[redacted:anthropic-key]",
  },
  {
    name: "aws-access-key",
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
    replacement: "[redacted:aws-access-key]",
  },
  {
    name: "slack-token",
    pattern: /\bxox[aboprs]-[A-Za-z0-9-]{10,}\b/g,
    replacement: "[redacted:slack-token]",
  },
  {
    name: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    replacement: "[redacted:jwt]",
  },
  {
    name: "private-key-block",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: "[redacted:private-key]",
  },
];

export function redact(text: string, options?: RedactionOptions): string {
  if (!text || !options) return text;
  let out = text;

  if (options.secrets) {
    for (const rule of SECRET_RULES) {
      out = out.replace(rule.pattern, rule.replacement ?? "[redacted]");
    }
  }
  if (options.email) {
    out = out.replace(EMAIL_RULE.pattern, EMAIL_RULE.replacement ?? "[redacted]");
  }
  if (options.phone) {
    out = out.replace(PHONE_RULE.pattern, PHONE_RULE.replacement ?? "[redacted]");
  }
  if (options.rules) {
    for (const rule of options.rules) {
      out = out.replace(rule.pattern, rule.replacement ?? `[redacted:${rule.name}]`);
    }
  }

  return out;
}

export function redactEpisodeText<T extends { text: string }>(episode: T, options?: RedactionOptions): T {
  if (!options) return episode;
  return { ...episode, text: redact(episode.text, options) };
}
