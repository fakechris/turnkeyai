# Runtime Core v2 规划

> 更新日期：2026-03-29  
> 目的：把当前仓库状态收敛成可执行的工程规划，而不是停留在方向判断

## 1. 这份规划解决什么问题

当前仓库已经证明：

1. `Team -> Role -> Worker -> BrowserBridge` 主链成立
2. session / target / ref / artifact 第一版成立
3. `spawn / send / resume / interrupt / cancel` 第一版成立

但下一阶段的真正瓶颈，不再是“链路能不能跑通”，而是：

1. context 还是 assembler，不是 compiler
2. memory 还是 summary，不是 hierarchy
3. worker/runtime 还是 hot resume，不是 durable execution
4. tool use 还是 discovery，不是 policy-governed execution
5. replay 还是局部记录，不是统一 eval / audit 基础设施

所以这份规划的重点，不是继续扩功能面，而是先把当前 runtime 骨架往生产可用方向做稳，再把 runtime kernel 补齐。

## 2. 总体策略

我们不接受下面两种错误推进方式：

1. 先做 GUI，把核心机制的复杂性藏起来
2. 先堆更多 worker，用更多分支掩盖核心模型不稳

我们采用的推进方式是：

1. **Phase 1: Production Hardening**
2. **Phase 2: Runtime Kernel Lift**
3. 再补 replay / eval / desktop shell

### 2.1 Phase 1: Production Hardening

第一期不是追求最完整抽象，而是优先把下面几类能力做稳：

1. prompt / memory / compaction 的真实运行链
2. sub-session、timeout、continue、re-entry 的续跑体验
3. 并行 sub-agent orchestration、fan-out、merge-synthesis
4. tool registry、permission、audit、transport hierarchy
5. browser session / target / ownership / reconnect
6. replay / failure analysis 的第一层产品化

第一期的目标是：

- 让 bounded 的真实任务可以稳定完成

### 2.2 Phase 2: Runtime Kernel Lift

第二期再把第一期已经跑稳的机制升级成统一内核：

1. durable execution journal + worker envelope
2. context compiler + atom / trust zone
3. memory ledger + cache taxonomy
4. tool manifest / decision / verifier
5. typed delegation / work package / merge gate

## 3. 工作流重构蓝图

第一期的目标链路更接近：

`User Intent -> Session -> Tool/Worker Execution -> Artifact/File Memory -> Continue/Replay`

第二期的目标链路再收敛为：

`User Intent -> Work Package -> Role Activation -> Context Compiler -> Tool/Worker Decision -> Receipt/Artifact -> Memory Admission -> Replay/Eval`

这意味着后续系统的关键对象，不再只是 message 和 summary，还包括：

1. execution event
2. work package
3. context atom
4. memory ledger entry
5. tool decision
6. tool receipt
7. trace span

下面的 Workstream 主要描述第二期 `Runtime Kernel Lift` 的目标对象与替换点；第一期仍以 production hardening 为前置门槛，不建议跳过。

## 4. Workstream A: Durable Runtime Core

### 4.1 目标态

把当前 snapshot-first runtime 升级成 execution-first runtime。

### 4.2 关键设计

新增核心对象：

```ts
type ExecutionEvent =
  | { type: "flow.created"; flowId: string }
  | { type: "handoff.enqueued"; taskId: string; toRoleId: string }
  | { type: "role.activated"; runKey: string }
  | { type: "worker.spawned"; workerRunKey: string; workerType: string }
  | { type: "worker.checkpointed"; workerRunKey: string; checkpointRef: string }
  | { type: "tool.call.started"; callId: string; toolName: string }
  | { type: "tool.call.completed"; callId: string; receiptId: string }
  | { type: "memory.admitted"; entryId: string }
  | { type: "run.cancelled"; runKey: string; reason: string };
```

```ts
type WorkerEnvelope = {
  workerRunKey: string;
  parentRunKey: string;
  status: "created" | "running" | "waiting" | "resumable" | "done" | "failed" | "cancelled";
  leaseOwner?: string;
  leaseUntil?: number;
  checkpointRef?: string;
  tokenBudget: number;
  toolBudget: number;
};
```

### 4.3 仓库替换点

1. `packages/worker-runtime/src/in-memory-worker-runtime.ts`
2. `packages/team-runtime/src/scheduled-task-runtime.ts`
3. `packages/team-store/src/file-flow-ledger-store.ts`
4. `packages/team-store/src/file-role-run-store.ts`
5. 新增 execution journal store 和 projection rebuilder

### 4.4 第一批交付

1. journal append/read API
2. worker checkpoint store
3. lease + heartbeat
4. cancellation propagation
5. side-effect receipt 基础模型
6. fan-out / fan-in 事件类型

### 4.5 验收标准

1. worker 进程级崩溃后可按 checkpoint 恢复
2. scheduled re-entry 恢复后不会丢失 parent context
3. `interrupt` / `cancel` / `resume` 都有 journal 记录
4. side-effectful 工具不会因重试重复提交

### 4.6 Phase 1 补充：Parallel Subagent Orchestration

在进入更重的 typed delegation / work package 之前，第一期需要先把已经存在的并行子运行能力做成稳定产品能力。

第一批目标：

1. 明确 parent-run 下的 task shard / sub-session group
2. fan-out 后的 coverage check
3. merge-synthesis 前的 completeness gate
4. partial / conflicting result 的 follow-up policy
5. main run 对 parallel child runs 的 timeout / cancel / retry 语义

这部分不要求一开始就抽成完整 kernel，但必须先成为清晰的 runtime contract；否则后续再做 typed delegation 时，行为会继续散落在 planner 和 prompt 里。

## 5. Workstream B: Context Compiler

### 5.1 目标态

把当前 `PromptAssembler + RoleMemoryResolver + ContextBudgeter` 的散装过程，收敛成单一编译管线：

`normalize -> recall -> rank -> pack -> render`

### 5.2 关键设计

```ts
type TrustZone =
  | "policy"
  | "user"
  | "verified-tool"
  | "untrusted-external"
  | "model-derived";

type ContextAtom = {
  atomId: string;
  kind: string;
  scope: "run" | "thread" | "project" | "user";
  trustZone: TrustZone;
  content: string;
  tokenCost: number;
  hardRequired?: boolean;
  sticky?: boolean;
  confidence?: number;
  freshnessTs?: number;
  provenance: { sourceIds: string[]; derivedFrom?: string[] };
};
```

```ts
type CompiledContext = {
  systemPrompt: string;
  taskPrompt: string;
  atoms: ContextAtom[];
  omitted: Array<{ atomId: string; reason: string }>;
  compileFingerprint: string;
};
```

### 5.3 仓库替换点

1. `packages/role-runtime/src/prompt-policy.ts`
2. `packages/role-runtime/src/prompt/prompt-assembler.ts`
3. `packages/role-runtime/src/context/context-budgeter.ts`
4. `packages/role-runtime/src/context/role-memory-resolver.ts`
5. `packages/team-runtime/src/context-state-maintainer.ts`

建议新增：

1. `packages/role-runtime/src/context/context-compiler.ts`
2. `packages/role-runtime/src/context/context-recall.ts`
3. `packages/role-runtime/src/context/context-ranker.ts`
4. `packages/role-runtime/src/context/context-packer.ts`
5. `packages/role-runtime/src/context/context-renderer.ts`

### 5.4 第一批交付

1. ContextAtom 数据结构
2. trust zone
3. compile fingerprint
4. retrieval candidate ranking
5. atom-level budget packing

### 5.5 验收标准

1. prompt 不再只能解释为 section 拼接结果
2. omission / ranking / pack 决策可追踪
3. worker/browser 外部内容被标记为正确 trust zone
4. compile fingerprint 可用于 replay、cache、diff

## 6. Workstream C: Memory Hierarchy + Cache

### 6.1 目标态

把当前 `ThreadSummary / RoleScratchpad / WorkerEvidenceDigest` 从最终记忆，降级为 projection；
真正的一等对象改为 memory ledger。

### 6.2 关键设计

```ts
type MemoryLedgerEntry = {
  entryId: string;
  scope: "thread" | "project" | "user";
  tier: "working" | "episodic" | "semantic" | "artifact" | "capability";
  kind: "fact" | "decision" | "preference" | "failure-pattern" | "artifact-digest" | "tool-readiness";
  status: "candidate" | "verified" | "disputed" | "expired";
  content: string;
  confidence: number;
  provenance: { sourceEventIds: string[]; artifactIds?: string[]; workerRunKeys?: string[] };
  validFrom: number;
  validUntil?: number;
};
```

缓存分层：

1. prompt prefix cache
2. retrieval candidate cache
3. context compile cache
4. tool result cache
5. browser snapshot/ref cache

### 6.3 仓库替换点

1. `packages/team-store/src/context/*`
2. `packages/role-runtime/src/context/role-memory-resolver.ts`
3. `packages/team-runtime/src/context-state-maintainer.ts`
4. `packages/browser-bridge/src/refs/file-snapshot-ref-store.ts`

### 6.4 第一批交付

1. memory ledger store
2. admission policy
3. projection rebuilders
4. compile cache
5. retrieval candidate cache

### 6.5 验收标准

1. summary 不再直接充当 semantic truth
2. memory entry 有 provenance / status / tier
3. context cache 能按 fingerprint 和版本正确失效
4. browser/ref cache 不会跨 session/target 污染

## 7. Workstream D: Tool Policy + Browser Trust

### 7.1 目标态

把当前 capability discovery 升级成真正的 tool governance layer。

### 7.2 关键设计

```ts
type ToolManifest = {
  toolName: string;
  capability: string;
  transports: ("official_api" | "business_tool" | "browser")[];
  risk: "read-public" | "read-private" | "write-reversible" | "write-irreversible" | "financial" | "publish";
  requiresApproval: boolean;
  cachePolicy: "none" | "ttl" | "etag";
  idempotency: "required" | "optional" | "not-supported";
  verifier: string;
};
```

```ts
type ToolDecision = {
  allow: boolean;
  selectedTransport?: "official_api" | "business_tool" | "browser";
  needsApproval: boolean;
  trustLevel: "authoritative" | "verified" | "observational" | "untrusted";
  reason: string;
};
```

### 7.3 仓库替换点

1. `packages/worker-runtime/src/capability-discovery-service.ts`
2. `packages/worker-runtime/src/worker-registry.ts`
3. `packages/qc-runtime/src/api-execution-verifier.ts`
4. `packages/qc-runtime/src/auth-and-scope-diagnosis-policy.ts`
5. `packages/browser-bridge/*`

建议新增：

1. `packages/qc-runtime/src/tool-policy-engine.ts`
2. `packages/qc-runtime/src/tool-manifest.ts`
3. `packages/qc-runtime/src/tool-receipt.ts`

### 7.4 第一批交付

1. tool manifest registry
2. tool decision API
3. official API -> business tool -> browser fallback policy
4. browser trust downgrade
5. plan 权 / commit 权分离

### 7.5 验收标准

1. browser fallback 不再被静默视为 authoritative
2. 副作用工具必须具备 approval 或 idempotency
3. 诊断结果能反向驱动 policy、recovery 和 memory admission
4. tool retry / timeout / concurrency 行为可测试

## 8. Workstream E: Multi-Agent Coordination

### 8.1 目标态

不把系统做成自由群聊，而是做成受控的 work graph。

### 8.2 关键设计

```ts
type WorkPackage = {
  packageId: string;
  objective: string;
  deliverableSchema: string;
  acceptanceCriteria: string[];
  dependencies: string[];
  contextSliceRefs: string[];
  maxChildren: number;
  maxToolCalls: number;
};
```

原则：

1. agent 接收的是 work package contract，不是裸自然语言任务
2. 共享的是 artifact bus，不是全量聊天历史
3. merge 要走 verifier / acceptance gate，不靠自然语言总结

### 8.3 仓库替换点

1. `packages/team-runtime/src/coordination-engine.ts`
2. `packages/team-runtime/src/handoff-planner.ts`
3. `packages/team-runtime/src/role-run-coordinator.ts`

### 8.4 第一批交付

1. typed delegation contract
2. duplicate objective suppression
3. parent-child budget propagation
4. merge gate / arbitration hook

### 8.5 验收标准

1. 多分支并行时不会无界 fan-out
2. sibling 分支共享 artifact 而不是重复编译全量 context
3. parent 可以取消、等待、仲裁 child work package

## 9. Workstream F: QC / Replay / Eval

### 9.1 目标态

把 replay 从 browser 局部能力升级成全链路观测与回归能力。

### 9.2 关键设计

统一 trace/span：

1. run 是 trace
2. role activation / worker spawn / tool call / browser step / memory admission 是 span

### 9.3 仓库替换点

1. `packages/qc-runtime/src/file-replay-recorder.ts`
2. `packages/team-runtime/*`
3. `packages/role-runtime/*`
4. `packages/worker-runtime/*`

### 9.4 第一批交付

1. trace schema
2. replay index
3. failure taxonomy
4. regression harness

### 9.5 验收标准

1. 任一失败 run 都能定位到 compiler、tool、worker 或 browser 级别
2. 关键规划改动都能跑回归测试
3. 不同模型 / policy / compiler 版本可比较

## 10. 交付节奏建议

### 未来 6 周

1. prompt / memory / compaction 稳定化
2. sub-session / timeout summarize / continue / re-entry 稳定化
3. tool registry / approval / audit / browser fallback 护栏强化
4. browser session / target ownership 与 hot/warm resume 稳定化

### 未来 3 个月

1. durable worker envelope / journal skeleton 落地
2. ContextCompiler skeleton
3. memory ledger / cache taxonomy skeleton
4. replay 扩展到 role / worker / tool / memory

### 未来 6 个月

1. work package 调度与 merge gate
2. regression harness 成熟
3. Electron shell 接 trace / replay / approval surface

## 11. 非目标

当前这份规划不优先做：

1. 新增大量业务 worker
2. 先做漂亮 GUI
3. 先做复杂远程多租户
4. 先做自由形态的 swarm 群聊

## 12. 一句话结论

TurnkeyAI 下一阶段的关键，不是立刻把所有理想 kernel 一次补齐，而是先把当前已经会做的事在真实任务里做稳，再把这些稳定下来的机制系统化升级成更强的 runtime kernel。
