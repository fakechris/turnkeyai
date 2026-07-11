// Stage 8 engine cleanup — react-engine module barrel.
//
// These modules are role-runtime internals: the composition root
// (llm-response-generator.ts) and react-engine siblings import from here. This
// barrel is NOT exported from packages/role-runtime/package.json unless another
// package needs it.
//
// HARD INVARIANT: no react-engine/* module (including this barrel) may import
// ../llm-response-generator or anything that imports it.
export * from "./types";
export * from "./policy-trace";
export * from "./hook-orchestration-contract";
export * from "./hook-policy-trace";
export * from "./policy-trace-characterization";
export * from "./engine-run-state";
export * from "./engine-run-observer";
export * from "./engine-model-client";
export * from "./compaction-controller";
export * from "./runtime-checkpoint-summarizer";
export * from "./run-journal";
export * from "./run-trace";
export * from "./run-lifecycle";
export * from "./task-plan-controller";
export * from "./engine-forced-tool-round-runner";
export * from "./engine-final-response";
export * from "./engine-agent-runner";
export * from "./engine-role-toolkit";
export * from "./permission-policy";
export * from "./tool-call-normalizer";
export * from "./finalization-pipeline";
export * from "./execution-budget-controller";
export * from "./tool-argument-validator";
export * from "./continuation-controller";
export * from "./closeout-policy-registry";
export * from "./repair-policy-registry";
export * from "./completed-closeout-controller";
export * from "./terminal-closeout-controller";
export * from "./evidence-ledger";
export * from "./task-facts";
export * from "./legacy-text-detectors";
