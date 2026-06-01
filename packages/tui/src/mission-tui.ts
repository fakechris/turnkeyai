import type { ActivityEvent, Mission } from "@turnkeyai/core-types/mission";

export interface TuiMissionMetrics {
  missionId: string;
  status: Mission["status"];
  wallClockMs: number;
  timelineEventCount: number;
  tool: {
    requested: number;
    results: number;
    executed: number;
    skipped: number;
    failed: number;
    cancelled: number;
    timeouts: number;
  };
  sessions: {
    spawned: number;
    continued: number;
  };
  approvals: {
    requested: number;
    applied: number;
    decided: number;
  };
  recovery: {
    events: number;
  };
  browser: {
    profileFallbacks: number;
    latestProfileFallback?: {
      sessionId?: string;
      fallbackDir?: string;
    };
    failureBuckets: Array<{
      bucket: string;
      count: number;
      latestAtMs: number;
    }>;
  };
  liveness: {
    active: number;
    waiting: number;
    stale: number;
  };
  qualityGate: {
    status: "running" | "passed" | "needs_attention" | "blocked";
    finalAnswerEventId?: string;
    evidenceEvents: number;
    checks: Array<{
      name: string;
      status: "pass" | "warn" | "fail" | "pending";
      detail: string;
    }>;
  };
}

type TuiMissionMetricsInput = Partial<
  Omit<TuiMissionMetrics, "tool" | "sessions" | "approvals" | "recovery" | "browser" | "liveness" | "qualityGate">
> & {
  tool?: Partial<TuiMissionMetrics["tool"]>;
  sessions?: Partial<TuiMissionMetrics["sessions"]>;
  approvals?: Partial<TuiMissionMetrics["approvals"]>;
  recovery?: Partial<TuiMissionMetrics["recovery"]>;
  browser?: Partial<Omit<TuiMissionMetrics["browser"], "failureBuckets">> & {
    failureBuckets?: TuiMissionMetrics["browser"]["failureBuckets"];
  };
  liveness?: Partial<TuiMissionMetrics["liveness"]>;
  qualityGate?: Partial<Omit<TuiMissionMetrics["qualityGate"], "checks">> & {
    checks?: TuiMissionMetrics["qualityGate"]["checks"];
  };
};

export function parseMissionNewArgs(args: string): { title: string; desc: string } | null {
  const trimmed = args.trim();
  if (!trimmed) {
    return null;
  }

  const separator = trimmed.indexOf("::");
  if (separator >= 0) {
    const title = trimmed.slice(0, separator).trim();
    const desc = trimmed.slice(separator + 2).trim();
    if (!title || !desc) {
      return null;
    }
    return { title, desc };
  }

  return {
    title: truncateOneLine(trimmed, 80),
    desc: trimmed,
  };
}

export function formatMissionList(missions: Mission[], limit = 20): string[] {
  const safeMissions = Array.isArray(missions) ? missions.filter(isMissionRecord) : [];
  const sorted = [...safeMissions].sort((a, b) => b.createdAtMs - a.createdAtMs || a.id.localeCompare(b.id));
  const boundedLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 20;
  const visible = sorted.slice(0, boundedLimit);
  const lines = [`Missions: ${visible.length}${missions.length > visible.length ? ` of ${missions.length}` : ""}`];

  for (const mission of visible) {
    lines.push(`- ${mission.shortId} ${mission.id} [${mission.status}] ${mission.title}`);
    lines.push(
      `  mode=${mission.modeLabel} progress=${Math.round(mission.progress * 100)}% thread=${mission.threadId ?? "-"} created=${formatDateTime(mission.createdAtMs)}`
    );
  }

  if (visible.length === 0) {
    lines.push("  no missions found");
  }

  return lines;
}

export function formatMissionDetail(input: {
  mission: Mission;
  metrics: TuiMissionMetricsInput;
  timeline: ActivityEvent[];
  timelineLimit?: number;
}): string[] {
  const { mission } = input;
  const metrics = normalizeMissionMetrics(input.metrics, mission);
  const timelineLimit = input.timelineLimit ?? 8;
  const events = Array.isArray(input.timeline)
    ? input.timeline.filter(isActivityEventRecord).sort((a, b) => a.tMs - b.tMs || a.id.localeCompare(b.id))
    : [];
  const latestFinal = findLatestFinalAnswer(events);
  const checks = metrics.qualityGate.checks.filter((check) => check.status !== "pass");
  const browserBuckets = metrics.browser.failureBuckets;
  const recent = events.slice(-timelineLimit);
  const lines = [
    `Mission ${mission.shortId} (${mission.id})`,
    `  title: ${mission.title}`,
    `  status=${mission.status} quality=${metrics.qualityGate.status} progress=${Math.round(mission.progress * 100)}%`,
    `  mode=${mission.modeLabel} owner=${mission.ownerLabel} thread=${mission.threadId ?? "-"}`,
    `  wallClock=${formatDuration(metrics.wallClockMs)} events=${metrics.timelineEventCount} evidence=${metrics.qualityGate.evidenceEvents}`,
    `  tools requested/results/executed/failed/timeouts=${metrics.tool.requested}/${metrics.tool.results}/${metrics.tool.executed}/${metrics.tool.failed}/${metrics.tool.timeouts}`,
    `  sessions spawned/continued=${metrics.sessions.spawned}/${metrics.sessions.continued} approvals requested/applied/decided=${metrics.approvals.requested}/${metrics.approvals.applied}/${metrics.approvals.decided}`,
    `  browser profileFallbacks=${metrics.browser.profileFallbacks} failureBuckets=${browserBuckets.length}`,
    `  liveness active/waiting/stale=${metrics.liveness.active}/${metrics.liveness.waiting}/${metrics.liveness.stale}`,
  ];

  if (metrics.browser.profileFallbacks > 0 || browserBuckets.length > 0 || metrics.browser.latestProfileFallback) {
    lines.push("Browser attention:");
    for (const bucket of browserBuckets.slice(0, 5)) {
      lines.push(
        `- ${browserFailureBucketLabel(bucket.bucket)} (${bucket.bucket}): ${bucket.count} at ${formatDateTime(bucket.latestAtMs)}`
      );
    }
    if (browserBuckets.length > 5) {
      lines.push(`- ${browserBuckets.length - 5} more browser failure bucket(s) hidden`);
    }
    if (metrics.browser.latestProfileFallback) {
      const sessionId = metrics.browser.latestProfileFallback.sessionId ?? "-";
      const fallbackDir = metrics.browser.latestProfileFallback.fallbackDir ?? "-";
      lines.push(`- latest profile fallback: session=${sessionId} dir=${fallbackDir}`);
    }
  }

  if (checks.length > 0) {
    lines.push("Attention:");
    for (const check of checks) {
      lines.push(`- ${check.name} [${check.status}]: ${check.detail}`);
    }
  }

  if (latestFinal) {
    lines.push("Latest final answer:");
    lines.push(indentBlock(truncateOneLine(stripHtml(latestFinal.text), 500), "  "));
  }

  lines.push(`Recent timeline (${recent.length} of ${events.length}):`);
  for (const event of recent) {
    lines.push(
      `- ${formatDateTime(event.tMs)} ${event.kind}/${event.actor}${event.emph ? ` [${event.emph}]` : ""}: ${truncateOneLine(stripHtml(event.text), 180)}`
    );
  }
  if (recent.length === 0) {
    lines.push("  no timeline events");
  }

  return lines;
}

export function buildMissionCreatePayload(args: string): {
  title: string;
  desc: string;
  mode: "custom";
  modeLabel: "Custom";
  owner: "you";
  ownerLabel: "You";
} | null {
  const parsed = parseMissionNewArgs(args);
  if (!parsed) {
    return null;
  }
  return {
    ...parsed,
    mode: "custom",
    modeLabel: "Custom",
    owner: "you",
    ownerLabel: "You",
  };
}

export function parseMissionSendArgs(args: string, currentMissionId: string | null): { missionId: string; content: string } | null {
  const trimmed = args.trim();
  if (!trimmed) {
    return null;
  }

  const [first, ...rest] = trimmed.split(/\s+/);
  if (first && first.startsWith("msn.") && rest.length > 0) {
    return {
      missionId: first,
      content: rest.join(" ").trim(),
    };
  }

  if (!currentMissionId) {
    return null;
  }
  return {
    missionId: currentMissionId,
    content: trimmed,
  };
}

function findLatestFinalAnswer(events: ActivityEvent[]): ActivityEvent | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.kind === "thought" && event.actor === "role-lead") {
      return event;
    }
  }
  return null;
}

function normalizeMissionMetrics(input: TuiMissionMetricsInput, mission: Mission): TuiMissionMetrics {
  return {
    missionId: asString(input.missionId, mission.id),
    status: isMissionStatus(input.status) ? input.status : mission.status,
    wallClockMs: asNonNegativeNumber(input.wallClockMs),
    timelineEventCount: asNonNegativeNumber(input.timelineEventCount),
    tool: {
      requested: asNonNegativeNumber(input.tool?.requested),
      results: asNonNegativeNumber(input.tool?.results),
      executed: asNonNegativeNumber(input.tool?.executed),
      skipped: asNonNegativeNumber(input.tool?.skipped),
      failed: asNonNegativeNumber(input.tool?.failed),
      cancelled: asNonNegativeNumber(input.tool?.cancelled),
      timeouts: asNonNegativeNumber(input.tool?.timeouts),
    },
    sessions: {
      spawned: asNonNegativeNumber(input.sessions?.spawned),
      continued: asNonNegativeNumber(input.sessions?.continued),
    },
    approvals: {
      requested: asNonNegativeNumber(input.approvals?.requested),
      applied: asNonNegativeNumber(input.approvals?.applied),
      decided: asNonNegativeNumber(input.approvals?.decided),
    },
    recovery: {
      events: asNonNegativeNumber(input.recovery?.events),
    },
    browser: {
      profileFallbacks: asNonNegativeNumber(input.browser?.profileFallbacks),
      ...normalizeLatestProfileFallback(input.browser?.latestProfileFallback),
      failureBuckets: normalizeBrowserFailureBuckets(input.browser?.failureBuckets),
    },
    liveness: {
      active: asNonNegativeNumber(input.liveness?.active),
      waiting: asNonNegativeNumber(input.liveness?.waiting),
      stale: asNonNegativeNumber(input.liveness?.stale),
    },
    qualityGate: {
      status: isQualityGateStatus(input.qualityGate?.status) ? input.qualityGate.status : "running",
      ...(typeof input.qualityGate?.finalAnswerEventId === "string"
        ? { finalAnswerEventId: input.qualityGate.finalAnswerEventId }
        : {}),
      evidenceEvents: asNonNegativeNumber(input.qualityGate?.evidenceEvents),
      checks: Array.isArray(input.qualityGate?.checks) ? input.qualityGate.checks.filter(isQualityCheckRecord) : [],
    },
  };
}

function normalizeLatestProfileFallback(value: unknown): Pick<TuiMissionMetrics["browser"], "latestProfileFallback"> {
  if (typeof value !== "object" || value === null) {
    return {};
  }
  const record = value as { sessionId?: unknown; fallbackDir?: unknown };
  const sessionId = typeof record.sessionId === "string" ? sanitizeTerminalText(record.sessionId) : undefined;
  const fallbackDir =
    typeof record.fallbackDir === "string" ? sanitizeTerminalText(record.fallbackDir) : undefined;
  if (!sessionId && !fallbackDir) {
    return {};
  }
  return {
    latestProfileFallback: {
      ...(sessionId ? { sessionId } : {}),
      ...(fallbackDir ? { fallbackDir } : {}),
    },
  };
}

function normalizeBrowserFailureBuckets(input: unknown): TuiMissionMetrics["browser"]["failureBuckets"] {
  if (!Array.isArray(input)) {
    return [];
  }
  return input
    .filter(isBrowserFailureBucketRecord)
    .map((bucket) => ({
      bucket: sanitizeTerminalText(bucket.bucket),
      count: asNonNegativeNumber(bucket.count),
      latestAtMs: asNonNegativeNumber(bucket.latestAtMs),
    }))
    .filter((bucket): bucket is TuiMissionMetrics["browser"]["failureBuckets"][number] => Boolean(bucket.bucket) && bucket.count > 0)
    .sort((left, right) => right.latestAtMs - left.latestAtMs || right.count - left.count || left.bucket.localeCompare(right.bucket));
}

function isBrowserFailureBucketRecord(value: unknown): value is TuiMissionMetrics["browser"]["failureBuckets"][number] {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { bucket?: unknown }).bucket === "string" &&
    typeof (value as { count?: unknown }).count === "number" &&
    typeof (value as { latestAtMs?: unknown }).latestAtMs === "number"
  );
}

function browserFailureBucketLabel(bucket: string): string {
  switch (bucket) {
    case "session_not_found":
      return "Browser session unavailable";
    case "browser_cdp_unavailable":
      return "Browser CDP unavailable";
    case "target_not_found":
      return "Target disappeared";
    case "attach_failed":
      return "Target attach failed";
    case "expert_session_detached":
      return "Expert session detached";
    case "cdp_command_timeout":
      return "CDP command timed out";
    case "detached_target":
      return "Target detached";
    case "transport_failure":
      return "Transport failure";
    case "owner_mismatch":
      return "Owner mismatch";
    case "lease_conflict":
      return "Lease conflict";
    default:
      return sentenceCase(bucket.replace(/_/g, " "));
  }
}

function sanitizeTerminalText(value: string): string | undefined {
  const cleaned = value
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || undefined;
}

function sentenceCase(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return trimmed;
  }
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

function truncateOneLine(value: string, maxLength: number): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxLength) {
    return oneLine;
  }
  return `${oneLine.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, "");
}

function indentBlock(value: string, prefix: string): string {
  return value
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function formatDateTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) {
    return "-";
  }
  try {
    const date = new Date(ms);
    if (!Number.isFinite(date.getTime())) {
      return "-";
    }
    return date.toISOString();
  } catch {
    return "-";
  }
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return "-";
  }
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) {
    return `${seconds}s`;
  }
  return `${minutes}m ${seconds}s`;
}

function isMissionRecord(value: Mission): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof value.id === "string" &&
    typeof value.shortId === "string" &&
    typeof value.title === "string" &&
    typeof value.status === "string" &&
    typeof value.modeLabel === "string" &&
    Number.isFinite(value.createdAtMs) &&
    Number.isFinite(value.progress)
  );
}

function isActivityEventRecord(value: ActivityEvent): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof value.id === "string" &&
    typeof value.kind === "string" &&
    typeof value.actor === "string" &&
    typeof value.text === "string" &&
    Number.isFinite(value.tMs)
  );
}

function isQualityCheckRecord(value: TuiMissionMetrics["qualityGate"]["checks"][number]): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof value.name === "string" &&
    typeof value.detail === "string" &&
    (value.status === "pass" || value.status === "warn" || value.status === "fail" || value.status === "pending")
  );
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function asNonNegativeNumber(value: unknown): number {
  return Number.isFinite(value) && typeof value === "number" && value >= 0 ? value : 0;
}

function isMissionStatus(value: unknown): value is Mission["status"] {
  return (
    value === "draft" ||
    value === "planning" ||
    value === "working" ||
    value === "needs_approval" ||
    value === "blocked" ||
    value === "done" ||
    value === "archived"
  );
}

function isQualityGateStatus(value: unknown): value is TuiMissionMetrics["qualityGate"]["status"] {
  return value === "running" || value === "passed" || value === "needs_attention" || value === "blocked";
}
