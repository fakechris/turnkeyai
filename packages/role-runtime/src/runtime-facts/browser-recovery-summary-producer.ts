import type { NativeToolRoundTrace } from "../native-tool-messages";
import { readLegacyBrowserRecoverySummariesFromToolTrace } from "../tool-loop-shared";

export function readRuntimeBrowserSummariesFromTrace(
  toolTrace: NativeToolRoundTrace[],
): string[] {
  return readLegacyBrowserRecoverySummariesFromToolTrace(toolTrace);
}
