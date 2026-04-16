export interface BrowserExcerptSafetyReport {
  normalizedExcerpt: string;
  suspicious: boolean;
  issues: string[];
}

const SUSPICIOUS_EXCERPT_RULES: Array<{ issue: string; pattern: RegExp }> = [
  {
    issue: "page excerpt attempts to override prior instructions",
    pattern: /\b(ignore|disregard|forget)\b[\s\S]{0,40}\b(previous|prior|earlier)\b[\s\S]{0,40}\b(instruction|prompt|message)s?\b/i,
  },
  {
    issue: "page excerpt references hidden prompt layers",
    pattern: /\b(system prompt|developer message|assistant instruction|hidden prompt)\b/i,
  },
  {
    issue: "page excerpt attempts to control tool execution",
    pattern: /\b(call|use|execute|run)\b[\s\S]{0,30}\b(tool|function|shell command|browser action)s?\b/i,
  },
  {
    issue: "page excerpt attempts to force a specific output contract",
    pattern: /\b(output|return|respond with|reply with)\b[\s\S]{0,30}\b(exactly|only|json|yaml|markdown)\b/i,
  },
];

export function inspectBrowserExcerptSafety(excerpt: string): BrowserExcerptSafetyReport {
  const normalizedExcerpt = excerpt.replace(/\s+/g, " ").trim();
  const issues = SUSPICIOUS_EXCERPT_RULES
    .filter((rule) => rule.pattern.test(normalizedExcerpt))
    .map((rule) => rule.issue);

  return {
    normalizedExcerpt,
    suspicious: issues.length > 0,
    issues,
  };
}
