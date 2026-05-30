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
}

export function validateAgentWorkbenchLedger(content: string): LedgerValidationResult {
  const checkpoints = extractCheckpointBlocks(content);
  const issues: LedgerValidationIssue[] = [];

  if (checkpoints.length === 0) {
    issues.push({
      checkpoint: "ledger",
      message: "no dated checkpoints found",
    });
  }

  for (const checkpoint of checkpoints) {
    const direction = checkpoint.body.match(/^Direction:\s*(\S+)\s*$/m)?.[1];
    if (!direction) {
      issues.push({ checkpoint: checkpoint.heading, message: "missing Direction line" });
    } else if (!VALID_DIRECTIONS.has(direction)) {
      issues.push({
        checkpoint: checkpoint.heading,
        message: `invalid Direction '${direction}'`,
      });
    }

    for (const section of REQUIRED_SECTIONS) {
      if (!hasNonEmptySection(checkpoint.body, section)) {
        issues.push({
          checkpoint: checkpoint.heading,
          message: `missing or empty ${section} section`,
        });
      }
    }
  }

  return {
    checkpoints: checkpoints.length,
    issues,
  };
}

function extractCheckpointBlocks(content: string): CheckpointBlock[] {
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
    if (!isDatedCheckpointHeading(heading.title)) {
      continue;
    }
    const next = headings[index + 1];
    blocks.push({
      heading: heading.title,
      body: content.slice(heading.end, next?.index ?? content.length),
    });
  }
  return blocks;
}

function isDatedCheckpointHeading(heading: string): boolean {
  return /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+\S+\s+-\s+.+$/.test(heading);
}

function hasNonEmptySection(body: string, section: string): boolean {
  const sectionPositions = REQUIRED_SECTIONS.map((candidate) => {
    const match = new RegExp(`^${escapeRegExp(candidate)}:\\s*$`, "m").exec(body);
    return match ? { section: candidate, start: match.index, end: match.index + match[0].length } : null;
  }).filter((candidate): candidate is { section: (typeof REQUIRED_SECTIONS)[number]; start: number; end: number } =>
    Boolean(candidate)
  );
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
