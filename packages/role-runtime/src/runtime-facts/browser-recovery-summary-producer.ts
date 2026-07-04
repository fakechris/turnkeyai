import type { NativeToolRoundTrace } from "../native-tool-messages";
import { collectBrowserRecoverySummariesFromToolTrace } from "../tool-loop-shared";

export function readRuntimeBrowserSummariesFromTrace(
  toolTrace: NativeToolRoundTrace[],
): string[] {
  return collectBrowserRecoverySummariesFromToolTrace(toolTrace);
}
