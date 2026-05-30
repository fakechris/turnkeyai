import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VALID_DIRECTIONS = new Set(["converging", "oscillating", "blocked", "unknown"]);
const REQUIRED_SECTIONS = [
  "Execution Kernel",
  "Result Quality",
  "Workbench UX",
  "Browser Reliability",
  "Acceptance Evidence",
  "Regression Risk",
] as const;
const REQUIRED_DAILY_REVIEW_SECTIONS = [
  "Repeated Issue Classes",
  "E2E Trend",
  "Decision",
  "Methodology Review Trigger",
] as const;
const DAILY_REVIEW_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface LedgerValidationIssue {
  checkpoint: string;
  message: string;
}

export interface LedgerValidationResult {
  checkpoints: number;
  issues: LedgerValidationIssue[];
}

interface CheckpointBlock {
  heading: string;
  body: string;
  timestampMs: number;
  kind: "checkpoint" | "daily-review";
}

export function validateAgentWorkbenchLedger(content: string): LedgerValidationResult {
  const datedBlocks = extractDatedBlocks(content);
  const checkpoints = datedBlocks.filter((block) => block.kind === "checkpoint");
  const dailyReviews = datedBlocks.filter((block) => block.kind === "daily-review");
  const issues: LedgerValidationIssue[] = [];

  if (datedBlocks.length === 0) {
    issues.push({
      checkpoint: "ledger",
      message: "no dated checkpoints or daily reviews found",
    });
  }

  for (const checkpoint of checkpoints) {
    collectDirectionIssues(checkpoint, issues);

    for (const section of REQUIRED_SECTIONS) {
      if (!hasNonEmptySection(checkpoint.body, section, REQUIRED_SECTIONS)) {
        issues.push({
          checkpoint: checkpoint.heading,
          message: `missing or empty ${section} section`,
        });
      }
    }
  }

  for (const dailyReview of dailyReviews) {
    collectDirectionIssues(dailyReview, issues);
    for (const section of REQUIRED_DAILY_REVIEW_SECTIONS) {
      if (!hasNonEmptySection(dailyReview.body, section, REQUIRED_DAILY_REVIEW_SECTIONS)) {
        issues.push({
          checkpoint: dailyReview.heading,
          message: `missing or empty ${section} section`,
        });
      }
    }
  }

  const cadenceIssue = validateDailyReviewCadence(datedBlocks, dailyReviews);
  if (cadenceIssue) {
    issues.push(cadenceIssue);
  }

  return {
    checkpoints: datedBlocks.length,
    issues,
  };
}

function collectDirectionIssues(block: CheckpointBlock, issues: LedgerValidationIssue[]): void {
  const direction = block.body.match(/^Direction:\s*(\S+)\s*$/m)?.[1];
  if (!direction) {
    issues.push({ checkpoint: block.heading, message: "missing Direction line" });
  } else if (!VALID_DIRECTIONS.has(direction)) {
    issues.push({
      checkpoint: block.heading,
      message: `invalid Direction '${direction}'`,
    });
  }
}

function validateDailyReviewCadence(
  datedBlocks: CheckpointBlock[],
  dailyReviews: CheckpointBlock[]
): LedgerValidationIssue | null {
  if (datedBlocks.length < 2) {
    return null;
  }
  const sorted = [...datedBlocks].sort((left, right) => left.timestampMs - right.timestampMs);
  const earliest = sorted[0]!;
  const latest = sorted[sorted.length - 1]!;
  if (latest.timestampMs - earliest.timestampMs < DAILY_REVIEW_INTERVAL_MS) {
    return null;
  }
  let lastReviewBoundary = earliest.timestampMs;
  for (const review of [...dailyReviews].sort((left, right) => left.timestampMs - right.timestampMs)) {
    if (review.timestampMs < earliest.timestampMs || review.timestampMs > latest.timestampMs) {
      continue;
    }
    if (review.timestampMs - lastReviewBoundary > DAILY_REVIEW_INTERVAL_MS) {
      return {
        checkpoint: "ledger",
        message: "missing dated 24-Hour Goal Review within a 24-hour ledger window",
      };
    }
    lastReviewBoundary = review.timestampMs;
  }
  if (latest.timestampMs - lastReviewBoundary > DAILY_REVIEW_INTERVAL_MS) {
    return {
      checkpoint: "ledger",
      message: "missing dated 24-Hour Goal Review within a 24-hour ledger window",
    };
  }
  return null;
}

function extractDatedBlocks(content: string): CheckpointBlock[] {
  const headingPattern = /^##\s+(.+)$/gm;
  const headings: Array<{ title: string; index: number; end: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = headingPattern.exec(content)) !== null) {
    const title = match[1]!.trim();
    headings.push({ title, index: match.index, end: headingPattern.lastIndex });
  }

  const blocks: CheckpointBlock[] = [];
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index]!;
    const timestampMs = parseDatedHeadingTimestamp(heading.title);
    if (timestampMs === null) {
      continue;
    }
    const next = headings[index + 1];
    blocks.push({
      heading: heading.title,
      body: content.slice(heading.end, next?.index ?? content.length),
      timestampMs,
      kind: isDailyReviewHeading(heading.title) ? "daily-review" : "checkpoint",
    });
  }
  return blocks;
}

function parseDatedHeadingTimestamp(heading: string): number | null {
  const match = heading.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})\s+\S+\s+-\s+.+$/);
  if (!match) {
    return null;
  }
  const [, year, month, day, hour, minute] = match;
  return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
}

function isDailyReviewHeading(heading: string): boolean {
  return /\b24-Hour Goal Review\b/i.test(heading);
}

function hasNonEmptySection(body: string, section: string, sections: readonly string[]): boolean {
  const sectionPositions = sections.map((candidate) => {
    const match = new RegExp(`^${escapeRegExp(candidate)}:\\s*$`, "m").exec(body);
    return match ? { section: candidate, start: match.index, end: match.index + match[0].length } : null;
  }).filter((candidate): candidate is { section: string; start: number; end: number } => Boolean(candidate));
  const current = sectionPositions.find((candidate) => candidate.section === section);
  if (!current) {
    return false;
  }
  const next = sectionPositions
    .filter((candidate) => candidate.start > current.start)
    .sort((left, right) => left.start - right.start)[0];
  return body.slice(current.end, next?.start ?? body.length).trim().length > 0;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function runCli(): void {
  const args = process.argv.slice(2);
  const ledgerPath = args.find((arg) => !arg.startsWith("--")) ?? "docs/progress/agent-workbench-goal-ledger.md";
  const resolvedPath = path.resolve(process.cwd(), ledgerPath);
  const result = validateAgentWorkbenchLedger(readFileSync(resolvedPath, "utf8"));
  if (result.issues.length > 0) {
    for (const issue of result.issues) {
      console.error(`[fail] ${issue.checkpoint}: ${issue.message}`);
    }
    console.error(`agent workbench ledger check failed: ${result.issues.length} issue(s)`);
    process.exit(1);
  }
  console.log(`agent workbench ledger check passed: ${result.checkpoints} checkpoint(s)`);
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  runCli();
}
