import type { MissionObservabilitySnapshot } from "../api/mission-api";

export interface BrowserFailureBucketRow {
  bucket: string;
  label: string;
  count: number;
  latestAtMs: number;
  countLabel: string;
}

export function selectBrowserFailureBucketRows(
  buckets?: MissionObservabilitySnapshot["browser"]["failureBuckets"] | null
): BrowserFailureBucketRow[] {
  return [...(buckets ?? [])]
    .sort((left, right) => right.latestAtMs - left.latestAtMs || right.count - left.count || left.bucket.localeCompare(right.bucket))
    .map((bucket) => ({
      bucket: bucket.bucket,
      label: browserFailureBucketLabel(bucket.bucket),
      count: bucket.count,
      latestAtMs: bucket.latestAtMs,
      countLabel: `${bucket.count} occurrence${bucket.count === 1 ? "" : "s"}`,
    }));
}

export function browserFailureBucketLabel(bucket: string): string {
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
      return bucket.replace(/_/g, " ");
  }
}
