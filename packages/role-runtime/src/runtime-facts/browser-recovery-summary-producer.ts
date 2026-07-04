import type { NativeToolRoundTrace } from "../native-tool-messages";
import { readPolicyBrowserRecoverySummariesFromToolTrace } from "./policy-text-facts";

export function readRuntimeBrowserSummariesFromTrace(
  toolTrace: NativeToolRoundTrace[],
): string[] {
  return readPolicyBrowserRecoverySummariesFromToolTrace(toolTrace);
}
