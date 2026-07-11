import type { LLMToolCall } from "@turnkeyai/llm-adapter/index";

import type { NativeToolRoundTrace } from "../native-tool-messages";
import type { TaskIntentFacts } from "../runtime-facts/types";

export const BOUNDED_SOURCE_CHECK_TIMEOUT_SECONDS = 25;

export function applyBoundedSourceCheckTimeoutBudget(
  calls: LLMToolCall[],
  input: {
    taskFacts?: Pick<
      TaskIntentFacts,
      "timeoutRecoveryRequested" | "sourceCheckContinuationRequested"
    >;
    toolTrace: NativeToolRoundTrace[];
  },
): LLMToolCall[] {
  if (
    !input.taskFacts?.timeoutRecoveryRequested ||
    !input.taskFacts.sourceCheckContinuationRequested ||
    input.toolTrace.some((round) =>
      round.calls.some((call) => call.name === "sessions_spawn"),
    )
  ) {
    return calls;
  }

  return calls.map((call) => {
    if (call.name !== "sessions_spawn") {
      return call;
    }
    const requested = call.input.timeout_seconds;
    const timeoutSeconds =
      typeof requested === "number" && Number.isFinite(requested) && requested > 0
        ? Math.min(requested, BOUNDED_SOURCE_CHECK_TIMEOUT_SECONDS)
        : BOUNDED_SOURCE_CHECK_TIMEOUT_SECONDS;
    return {
      ...call,
      input: {
        ...call.input,
        timeout_seconds: timeoutSeconds,
      },
    };
  });
}
