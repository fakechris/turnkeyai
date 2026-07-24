import assert from "node:assert/strict";
import test from "node:test";

import type {
  GenerateTextInput,
  GenerateTextResult,
} from "@turnkeyai/llm-adapter/index";

import { buildRuntimeCheckpointMessage } from "./compaction-controller";
import { createRuntimeCheckpointSummarizer } from "./runtime-checkpoint-summarizer";
import type { ModelCallBoundaryTrace } from "../model-call-trace";
import { createRunLifecycleRecorder } from "./run-lifecycle";

test("runtime checkpoint summarizer makes a tool-free deterministic gateway call and parses fenced JSON", async () => {
  let request: GenerateTextInput | undefined;
  const modelCallTrace: ModelCallBoundaryTrace[] = [];
  const lifecycle = createRunLifecycleRecorder({
    activation: {
      thread: { threadId: "thread-1" },
      flow: { flowId: "flow-1" },
      handoff: { taskId: "task-1" },
      runState: { runKey: "run-1", roleId: "role-1" },
    } as never,
  });
  let now = 100;
  const summarize = createRuntimeCheckpointSummarizer({
    gateway: {
      async generate(input): Promise<GenerateTextResult> {
        request = input;
        await input.onProviderLifecycle?.({
          kind: "attempt_started",
          at: 101,
          attempt: 1,
          modelId: "model-1",
          providerId: "provider-1",
          protocol: "anthropic-compatible",
        });
        await input.onProviderLifecycle?.({
          kind: "attempt_completed",
          at: 102,
          attempt: 1,
          modelId: "model-1",
          providerId: "provider-1",
          protocol: "anthropic-compatible",
        });
        return {
          text: [
            "```json",
            JSON.stringify({
              task: "Compare two pricing sources.",
              summary: "Source A was checked; Source B remains.",
              decisions: ["Prefer primary sources."],
              evidence: ["Source A lists an annual plan."],
              artifacts: ["artifact://source-a"],
              openQuestions: ["What does Source B list?"],
              planState: ["Inspect Source B."],
              errorsAndFixes: [],
            }),
            "```",
          ].join("\n"),
          modelId: "model-1",
          providerId: "provider-1",
          protocol: "anthropic-compatible",
          adapterName: "test",
          raw: {},
        };
      },
    },
    selection: { modelId: "model-1" },
    modelCallTrace,
    lifecycle,
    now: () => (now += 5),
    metadata: {
      roleId: "role-1",
      threadId: "thread-1",
      flowId: "flow-1",
    },
  });

  const draft = await summarize({
    taskPrompt: "Compare two pricing sources.",
    messages: [
      { role: "assistant", content: "I will inspect Source A." },
      { role: "tool", toolCallId: "call-1", content: "annual plan evidence" },
    ],
    round: 8,
  });

  assert.equal(draft.summary, "Source A was checked; Source B remains.");
  assert.deepEqual(draft.planState, ["Inspect Source B."]);
  assert.equal(request?.toolChoice, "none");
  assert.equal(request?.tools, undefined);
  assert.equal(request?.temperature, 0);
  assert.equal(request?.metadata?.purpose, "runtime_checkpoint_compaction");
  assert.match(String(request?.messages[1]?.content), /annual plan evidence/);
  assert.equal(modelCallTrace[0]?.phase, "checkpoint_compaction");
  assert.equal(modelCallTrace[0]?.round, 8);
  assert.deepEqual(lifecycle.snapshot().events, [
    {
      kind: "model_attempt_started",
      at: 101,
      attemptId: "checkpoint_compaction:8:1:1",
      phase: "checkpoint_compaction",
      round: 8,
    },
    {
      kind: "model_attempt_completed",
      at: 102,
      attemptId: "checkpoint_compaction:8:1:1",
    },
  ]);
  assert.equal(
    modelCallTrace[0]?.replayResponse?.text.includes("Source A was checked"),
    true,
  );
});

test("runtime checkpoint summarizer includes the prior checkpoint for cumulative merging", async () => {
  let request: GenerateTextInput | undefined;
  const summarize = createRuntimeCheckpointSummarizer({
    gateway: {
      async generate(input): Promise<GenerateTextResult> {
        request = input;
        return {
          text: JSON.stringify({
            summary: "Merged summary.",
            decisions: [],
            evidence: ["old", "new"],
            artifacts: [],
            openQuestions: [],
            planState: [],
            errorsAndFixes: [],
          }),
          modelId: "model-1",
          providerId: "provider-1",
          protocol: "openai-compatible",
          adapterName: "test",
          raw: {},
        };
      },
    },
    selection: { modelChainId: "chain-1" },
    metadata: {
      roleId: "role-1",
      threadId: "thread-1",
      flowId: "flow-1",
    },
  });
  const previousMessage = buildRuntimeCheckpointMessage({
    protocol: "turnkeyai.runtime_checkpoint.v1",
    version: 1,
    compactedAtRound: 6,
    sourceMessageCount: 4,
    task: "Compare sources.",
    summary: "Old summary.",
    decisions: [],
    evidence: ["old"],
    artifacts: [],
    openQuestions: [],
    planState: [],
  });
  const previous = JSON.parse(
    String(previousMessage.content).split("\n").slice(1).join("\n"),
  );

  await summarize({
    taskPrompt: "Compare sources.",
    previousCheckpoint: previous,
    messages: [{ role: "assistant", content: "new evidence" }],
    round: 9,
  });

  assert.match(String(request?.messages[1]?.content), /Old summary/);
  assert.match(String(request?.messages[1]?.content), /new evidence/);
  assert.equal(request?.modelChainId, "chain-1");
});

test("runtime checkpoint summarizer rejects malformed or incomplete checkpoint output", async () => {
  const summarize = createRuntimeCheckpointSummarizer({
    gateway: {
      async generate(): Promise<GenerateTextResult> {
        return {
          text: JSON.stringify({ evidence: ["missing summary"] }),
          modelId: "model-1",
          providerId: "provider-1",
          protocol: "openai-compatible",
          adapterName: "test",
          raw: {},
        };
      },
    },
    selection: { modelId: "model-1" },
    metadata: {
      roleId: "role-1",
      threadId: "thread-1",
      flowId: "flow-1",
    },
  });

  await assert.rejects(
    summarize({
      taskPrompt: "Compare sources.",
      messages: [{ role: "assistant", content: "evidence" }],
      round: 5,
    }),
    /invalid_runtime_checkpoint_summary/,
  );
});
