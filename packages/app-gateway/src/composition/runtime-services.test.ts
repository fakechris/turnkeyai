import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  DEFAULT_DAEMON_RUNTIME_LIMITS,
  LLM_SUB_AGENT_WORKER_KINDS,
  resolveRequestEnvelopeLimitOverridesFromEnv,
} from "./runtime-services";

test("default daemon runtime limits keep outer role loops aligned with the native tool loop budget", () => {
  assert.equal(DEFAULT_DAEMON_RUNTIME_LIMITS.memberMaxIterations, 128);
  assert.equal(DEFAULT_DAEMON_RUNTIME_LIMITS.flowMaxHops, 20);
  assert.equal(DEFAULT_DAEMON_RUNTIME_LIMITS.maxQueuedHandoffsPerRole, 4);
  assert.equal(DEFAULT_DAEMON_RUNTIME_LIMITS.maxPerRoleHopCount, 3);
});

test("daemon request envelope limit overrides read only positive integer env values", () => {
  assert.deepEqual(
    resolveRequestEnvelopeLimitOverridesFromEnv({
      TURNKEYAI_REQUEST_ENVELOPE_MAX_PROMPT_CHARS: "20000",
      TURNKEYAI_REQUEST_ENVELOPE_MAX_PROMPT_BYTES: "30000",
      TURNKEYAI_REQUEST_ENVELOPE_MAX_SERIALIZED_BYTES: "not-a-number",
      TURNKEYAI_REQUEST_ENVELOPE_MAX_TOOL_COUNT: "0",
    }),
    {
      maxPromptChars: 20_000,
      maxPromptBytes: 30_000,
    }
  );
  assert.equal(resolveRequestEnvelopeLimitOverridesFromEnv({}), undefined);
});

test("daemon leaves explore on the direct worker path for public read-only fetches", () => {
  assert.deepEqual([...LLM_SUB_AGENT_WORKER_KINDS], ["browser", "explore"]);
});

test("daemon composition shares one tool-result artifact store across writers and readers", () => {
  const source = readFileSync(
    new URL("./runtime-services.ts", import.meta.url),
    "utf8",
  );

  assert.match(
    source,
    /new FileToolResultArtifactStore\(\{\s*rootDir: path\.join\(dataDir, "tool-result-artifacts"\)/,
  );
  assert.match(source, /installLLMSubAgentWorkerHandlers\(\{[\s\S]*?toolResultArtifactStore,/);
  assert.match(source, /createNativeToolCapabilityRegistry\(\{[\s\S]*?artifactsEnabled: true,/);
  assert.match(source, /new LLMRoleResponseGenerator\(\{[\s\S]*?toolResultArtifactStore,/);
  assert.match(source, /new LLMRoleResponseGenerator\(\{[\s\S]*?runJournalStore: teamMessageStore,/);
  assert.match(source, /new LLMRoleResponseGenerator\(\{[\s\S]*?contextCheckpointStore,/);
  assert.match(source, /new LLMRoleResponseGenerator\(\{[\s\S]*?dynamicContextBaselineStore,/);
  assert.match(source, /new LLMRoleResponseGenerator\(\{[\s\S]*?taskPlanStateProvider:/);
  assert.match(source, /createWorkspaceAwarePreCompactionMemoryFlusher\(\{[\s\S]*?workspaceMemoryWriter:/);
  assert.match(source, /createWorkerSessionToolExecutor\(\{[\s\S]*?toolResultArtifactStore,/);
  assert.match(source, /startupStep\("worker-session-hygiene",[\s\S]*?sweepOrphanWorkerSessions\(\{/);
  assert.ok(
    source.indexOf('startupStep("worker-session-hygiene"') <
      source.indexOf('startupStep("worker-binding-reconcile"'),
  );
});
