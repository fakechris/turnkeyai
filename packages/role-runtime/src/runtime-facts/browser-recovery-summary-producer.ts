import type { NativeToolRoundTrace } from "../native-tool-messages";
import { readPolicyBrowserRecoverySummariesFromToolTrace } from "./text-fallback-readers";

export function readRuntimeBrowserSummariesFromTrace(
  toolTrace: NativeToolRoundTrace[],
): string[] {
  return readPolicyBrowserRecoverySummariesFromToolTrace(toolTrace);
}
