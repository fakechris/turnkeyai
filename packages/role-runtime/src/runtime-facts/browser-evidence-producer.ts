import type { NativeToolRoundTrace } from "../native-tool-messages";
import { parseSessionToolResult } from "../session-tool-result-protocol";
import type {
  BrowserEvidenceEvent,
  BrowserEvidenceFacts,
  BrowserFailureBucket,
  EvidenceEnvelope,
  EvidenceProvenance,
  RuntimeFactInput,
  TaskIntentFacts,
} from "./types";

export function produceBrowserEvidenceEnvelope(input: {
  taskIntent: TaskIntentFacts;
  toolTrace: RuntimeFactInput["toolTrace"];
}): EvidenceEnvelope<"browser_evidence", BrowserEvidenceFacts> {
  const events = collectBrowserEvents(input.toolTrace);
  const browserVisibleEvidenceEvents = events.filter((event) =>
    event.kind === "rendered_page" ||
    event.kind === "browser_snapshot" ||
    event.kind === "browser_recovery"
  );
  const productSignalDashboardEvidenceEvents = events.filter((event) =>
    event.kind === "product_signal_dashboard" ||
    eventLooksLikeProductSignalDashboard(event)
  );
  const failureBuckets = collectBrowserFailureBuckets(input.toolTrace);
  return {
    kind: "browser_evidence",
    schemaVersion: 1,
    facts: {
      events,
      browserVisibleEvidenceEvents,
      productSignalDashboardEvidenceEvents,
      failureBuckets,
      missingBrowserVisibleEvidence:
        input.taskIntent.browserVisibleEvidenceRequired &&
        browserVisibleEvidenceEvents.length === 0,
      missingProductSignalDashboardEvidence:
        input.taskIntent.productSignalDashboardEvidenceRequested &&
        productSignalDashboardEvidenceEvents.length === 0,
      missingBrowserEvidenceDimensions:
        input.taskIntent.browserVisibleEvidenceRequired &&
        browserVisibleEvidenceEvents.length > 0 &&
        browserVisibleEvidenceEvents.every(
          (event) => !event.url || !event.title,
        ),
    },
    provenance: buildBrowserProvenance(input.toolTrace),
  };
}

function collectBrowserEvents(
  toolTrace: NativeToolRoundTrace[],
): BrowserEvidenceEvent[] {
  const events: BrowserEvidenceEvent[] = [];
  for (const round of toolTrace) {
    for (const progress of round.progress ?? []) {
      if (!progress.toolName.startsWith("browser_")) {
        continue;
      }
      const detail = asRecord(progress.detail);
      const eventType = readString(detail?.["eventType"]);
      if (eventType === "browser.snapshot") {
        events.push({
          kind: eventLooksLikeProductSignalDashboard({
            title: readString(detail?.["title"]),
            url: readString(detail?.["finalUrl"]) ?? readString(detail?.["url"]),
          })
            ? "product_signal_dashboard"
            : "browser_snapshot",
          toolName: progress.toolName,
          toolCallId: progress.toolCallId,
          url: readString(detail?.["finalUrl"]) ?? readString(detail?.["url"]),
          title: readString(detail?.["title"]),
        });
      }
    }
    for (const result of round.results) {
      if (result.toolName.startsWith("browser_")) {
        const parsed = parseJsonObject(result.content ?? "");
        const url = readString(parsed?.["finalUrl"]) ?? readString(parsed?.["url"]);
        const title = readString(parsed?.["title"]);
        if (url || title) {
          events.push({
            kind: eventLooksLikeProductSignalDashboard({ title, url })
              ? "product_signal_dashboard"
              : "rendered_page",
            toolName: result.toolName,
            toolCallId: result.toolCallId,
            url,
            title,
          });
        }
      }
      if (
        result.toolName === "sessions_spawn" ||
        result.toolName === "sessions_send"
      ) {
        const parsed = result.content ? parseSessionToolResult(result.content) : null;
        const payload = asRecord(parsed?.payload);
        const recovery = asRecord(payload?.["browserRecovery"]);
        if (recovery) {
          events.push({
            kind: "browser_recovery",
            toolName: result.toolName,
            toolCallId: result.toolCallId,
            url:
              readString(recovery["finalUrl"]) ??
              readString(recovery["url"]) ??
              null,
            title: readString(recovery["title"]),
          });
        }
      }
    }
  }
  return dedupeEvents(events);
}

function collectBrowserFailureBuckets(
  toolTrace: NativeToolRoundTrace[],
): BrowserFailureBucket[] {
  const buckets = new Set<BrowserFailureBucket>();
  const add = (bucket: unknown) => {
    const normalized = normalizeBrowserFailureBucket(readString(bucket));
    if (normalized) buckets.add(normalized);
  };
  for (const round of toolTrace) {
    for (const progress of round.progress ?? []) {
      if (!progress.toolName.startsWith("browser_")) continue;
      for (const bucket of readFailureBucketValues(progress.detail)) {
        add(bucket);
      }
    }
    for (const result of round.results) {
      for (const bucket of readFailureBucketValues(
        parseJsonObject(result.content ?? ""),
      )) {
        add(bucket);
      }
      if (
        result.toolName === "sessions_spawn" ||
        result.toolName === "sessions_send"
      ) {
        const parsed = result.content ? parseSessionToolResult(result.content) : null;
        const payload = asRecord(parsed?.payload);
        for (const bucket of readFailureBucketValues(payload)) add(bucket);
        for (const bucket of readFailureBucketValues(payload?.["browserRecovery"])) {
          add(bucket);
        }
      }
      for (const bucket of readPolicyBrowserFailureBucketNames(result.content ?? "")) {
        add(bucket);
      }
    }
  }
  return [...buckets].sort();
}

function readFailureBucketValues(value: unknown): unknown[] {
  const record = asRecord(value);
  if (!record) return [];
  const buckets = record["failureBuckets"];
  if (!Array.isArray(buckets)) return [];
  return buckets.flatMap((bucket) => {
    if (typeof bucket === "string") return [bucket];
    const bucketRecord = asRecord(bucket);
    return bucketRecord ? [bucketRecord["bucket"]] : [];
  });
}

function normalizeBrowserFailureBucket(
  bucket: string | null,
): BrowserFailureBucket | null {
  if (!bucket) return null;
  switch (bucket.trim().toLowerCase()) {
    case "cdp_command_timeout":
    case "wait_condition_timeout":
      return "browser_timeout";
    case "target_not_found":
    case "attach_failed":
    case "expert_session_detached":
    case "detached_target":
    case "session_not_found":
    case "owner_mismatch":
    case "lease_conflict":
      return "browser_navigation_failed";
    case "browser_cdp_unavailable":
    case "transport_failure":
      return "browser_runtime_error";
    case "browser_missing_rendered_content":
      return "browser_missing_rendered_content";
    default:
      return "unknown_browser_failure";
  }
}

function readPolicyBrowserFailureBucketNames(text: string): string[] {
  const buckets = new Set<string>();
  const pattern =
    /\b(target_not_found|attach_failed|expert_session_detached|cdp_command_timeout|browser_cdp_unavailable|detached_target|session_not_found|wait_condition_timeout|transport_failure|owner_mismatch|lease_conflict)\b/gi;
  for (const match of text.matchAll(pattern)) {
    buckets.add(match[1]!.toLowerCase());
  }
  return [...buckets].sort();
}

function buildBrowserProvenance(
  toolTrace: NativeToolRoundTrace[],
): EvidenceProvenance[] {
  return toolTrace.flatMap((round, traceIndex) => [
    ...(round.progress ?? [])
      .filter((progress) => progress.toolName.startsWith("browser_"))
      .map((progress) => ({
        source: "tool_progress" as const,
        toolName: progress.toolName,
        toolCallId: progress.toolCallId,
        roundIndex: round.round,
        traceIndex,
        messageIndex: null,
      })),
    ...round.results
      .filter(
        (result) =>
          result.toolName.startsWith("browser_") ||
          result.toolName === "sessions_spawn" ||
          result.toolName === "sessions_send",
      )
      .map((result) => ({
        source: "native_tool_trace" as const,
        toolName: result.toolName,
        toolCallId: result.toolCallId,
        roundIndex: round.round,
        traceIndex,
        messageIndex: null,
      })),
  ]);
}

function eventLooksLikeProductSignalDashboard(input: {
  title: string | null;
  url: string | null;
}): boolean {
  return /\b(?:product-signals|product signal dashboard|live signal dashboard|signal dashboard)\b/i.test(
    [input.title, input.url].filter(Boolean).join("\n"),
  );
}

function dedupeEvents(events: BrowserEvidenceEvent[]): BrowserEvidenceEvent[] {
  const seen = new Set<string>();
  return events.filter((event) => {
    const key = [
      event.kind,
      event.toolName,
      event.toolCallId,
      event.url,
      event.title,
    ].join("\0");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return asRecord(parsed);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
