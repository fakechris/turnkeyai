import type { GenerateTextResult, LLMMessage } from "@turnkeyai/llm-adapter/index";

import type { NativeToolRoundTrace } from "../native-tool-messages";
import {
  maybeAppendBrowserFailureBucketVisibility,
  maybeAppendBrowserRecoveryResidualRiskVisibility,
  maybeAppendRecoveredTimeoutCloseoutVisibility,
  maybeAppendRequiredTimeoutFollowupVisibility,
  shouldAppendRecoveredTimeoutCloseoutVisibility,
} from "../tool-loop-shared";

// Stage 8 engine cleanup — FinalizationPipeline.
//
// Authority: own engine final text transforms after a final answer has been
// selected. The pure compatibility appenders remain in neutral shared helpers
// while inline is still the parity reference; this module pins the engine
// epilogue order.
export const FINALIZATION_PIPELINE_MODULE = "finalization-pipeline" as const;

export interface EngineFinalizationInput {
  result: GenerateTextResult;
  taskPrompt: string;
  messages: LLMMessage[];
  toolTrace: NativeToolRoundTrace[];
  evidenceText: string;
}

export function finalizeEngineAnswer(
  input: EngineFinalizationInput,
): GenerateTextResult {
  let result = input.result;
  if (
    shouldAppendRecoveredTimeoutCloseoutVisibility({
      resultText: result.text,
      taskPrompt: input.taskPrompt,
      messages: input.messages,
      toolTrace: input.toolTrace,
    })
  ) {
    result = maybeAppendRecoveredTimeoutCloseoutVisibility(result);
  }
  result = maybeAppendRequiredTimeoutFollowupVisibility({
    result,
    taskPrompt: input.taskPrompt,
    messages: input.messages,
    toolTrace: input.toolTrace,
  });
  result = maybeAppendBrowserRecoveryResidualRiskVisibility({
    result,
    taskPrompt: input.taskPrompt,
    messages: input.messages,
    toolTrace: input.toolTrace,
  });
  return maybeAppendBrowserFailureBucketVisibility({
    result,
    taskPrompt: input.taskPrompt,
    evidenceText: input.evidenceText,
  });
}
