# Coordination Engine Concurrency Audit

> 更新日期：2026-05-16
> 范围：`packages/team-runtime/src/coordination-engine.ts` 当前并发模型、不变量、已知风险、以及 P1.4 的真实下一步
> 不在范围：把整个 coordination engine 改成事件队列。原 P1.4 描述（"per-thread mutex → event queue, 让 LLM/browser I/O 出锁"）已经过期一半——现在的代码已经不是那种模型。

## 1. 这份文档解决什么问题

最初 P1 计划里的 P1.4 描述是：

> 把 coordination engine 的 `KeyedAsyncMutex` 换成事件队列；LLM 调用、browser action 必须出锁。

按这个描述硬做是大手术，且**前提已经不成立**。当前 coordination engine 不是"per-thread 大 mutex 包住外部 I/O"——它是按 flowId / intentId / edgeId keyed 的若干窄锁，外部 I/O（LLM / worker / browser）已经在 `InlineRoleLoopRunner` 里跑，不在 coordination 锁内。

本文档先把当前真实状态写清楚，再对真正存在的并发风险点做有界的小修。

## 2. 当前锁清单

`coordination-engine.ts` 里的全部 `KeyedAsyncMutex`：

_Reflects current `main` after this PR's R1 fix (see §5)._

| 锁字段 | 锁 key | 保护对象 | 锁内 await | 是否调用外部 I/O |
|---|---|---|---|---|
| `flowMutex` | `flowId` | FlowLedger 边/状态/shard group 的 read-modify-write | `flowLedgerStore.{get,put}`, `runtimeChainRecorder.*`（best-effort） | 否（纯 store I/O） |
| `flowStartIntentMutex` | `intentId` | 同一 ingress intent 不被重复 materialize | `teamMessageStore.appendIfAbsent`, `flowLedgerStore.put`, `dispatchToLead` / `dispatchToRole`，**包括它们传递性触发的 `summaryBuilder.getRecentMessages`** | 否（dispatch 内部进 dispatchOutboxShipper / flowMutex，不直调 LLM；但 summary builder 可能慢，见 §4 R3） |
| `dispatchDeliveryMutex` | `edgeId` | 同一 handoff edge 不被重复 deliver；只覆盖 read-modify-write 的 edge state | `flowLedgerStore.get`, `roleRunCoordinator.{getOrCreate,enqueue}`, `markHandoffDelivered` | 否（`roleLoopRunner.ensureRunning` 现在在锁外 await，见 §5 R1） |
| `roleOutcomeIntentMutex` | `intentId` | 同一 role reply/failure intent 不被重复 materialize | `teamThreadStore.get`, `requireFlow`, `materializeRoleReplyIntent` / `materializeRoleFailureIntent` | 否（reply/failure 内部进 flowMutex） |

`withFlowLock` 调用站点（9 处）：`recordHandoff`, `markHandoffResponded`, `markHandoffDelivered`, `markHandoffClosed`, `markHandoffCancelled`, `markRoleCompleted`, `markRoleFailed`, `removeActiveRole`, `recordShardReply`. 全部是 read-flow → mutate → put 的 CAS，受 `expectedVersion` 保护（见 `putFlow` 在 `coordination-engine.ts:1714`）。

## 3. Intent / Outbox 模型（当前已有，未正式命名）

`CoordinationEngine` 已经有三类 intent，每类都有对应的 `FileBatchOutbox` + `OutboxBatchShipper`：

| Intent 类型 | Outbox 字段 | Sink | 触发点 |
|---|---|---|---|
| **Ingress**（`FlowStartIntent`） | `ingressOutboxShipper` | `materializeFlowStartIntent` | 用户发消息 / scheduled task 触发 |
| **Dispatch**（`DispatchDeliveryIntent`） | `dispatchOutboxShipper` | `deliverDispatchIntent` | 一条 handoff edge 需要派发到 role run |
| **Role Outcome**（`RoleOutcomeIntent`） | `roleOutcomeOutboxShipper` | `materializeRoleOutcomeIntent` | role 完成回复 / 失败 |

每类 intent 走的是同一个 `enqueueClaimed → execute → ack` 信封：fast-path 立即同步执行 sink；失败时 outbox 自动重投递；shipper 后台 drain 兜底。

**这就是真正的"queue model"，只是还没被正式命名。**未来如果要把 coordination 整体 queue 化，正确做法不是新发明一套，而是把现有这三类 intent 的语义和不变量正式写下来（本文档在做这件事的第一步），再决定是否需要更强的有序保证（见 §6）。

## 4. 锁外做了什么 / 仍在锁内的是什么

完全在锁外（不持任何 coordination engine 锁）：

- **LLM 调用**：`PolicyRoleRuntime.runActivation` 在 `InlineRoleLoopRunner.ensureRunning` 的 `while(true)` 循环里，与 coordination engine 完全解耦。
- **Worker / browser action**：同上。
- **`roleLoopRunner.ensureRunning` 自身**：现在在 `dispatchDeliveryMutex` 之外 await（见 §5 R1）。

**仍可能在锁内**（部分场景）：

- **`summaryBuilder.getRecentMessages`**：`dispatchToRole` 里同步调用（`coordination-engine.ts:314` 附近）。**不在 `flowMutex` 里**——`dispatchToRole` 只在 `recordHandoff` 那一段进 `flowMutex`。但是当 `dispatchToRole` 是从 `materializeFlowStartIntent` 调用过来时（ingress 路径：`flowStartIntentMutex` → `dispatchToLead` → `dispatchToRole` → `summaryBuilder.getRecentMessages`），summary 调用确实在 `flowStartIntentMutex(intentId)` 内。
  - 影响范围：**同一个 intent** 的并发尝试会被排队（这本就是 flowStartIntentMutex 的目的）；不会跨 intent 影响其他 ingress。
  - 是否需要修：**不需要**。当前 summary 是纯 message store list 操作，毫秒级。如果未来 summary 接入 LLM 加工，这里要重新评估。

## 5. 已知风险点（按优先级排序）

### R1 — `deliverDispatchIntent` 历史上在 `dispatchDeliveryMutex` 内调用 `ensureRunning`（**已修，本 PR 修**）

**修复前**：`coordination-engine.ts:1441` 在锁内 `await this.deps.roleLoopRunner.ensureRunning(runState.runKey)`。

`ensureRunning`：
- 第一次调用某 runKey 时，进入 `while(true)` 循环驱动整个 role loop，每轮 `await roleRuntime.runActivation(...)`（含 LLM 调用）。直到循环 return（done / delegated / iteration 上限）才解锁。
- 第二次（含）调用同 runKey 时，`activeRuns.has(runKey)` 命中，立即 return。

修复前的后果：**该 edge 的 first-time 派发会把 `dispatchDeliveryMutex(edgeId)` 持有到 role loop 结束**。其他需要同 edgeId 的操作（最相关的是 `abandonDispatchIntent` 在 outbox dead-letter 路径上，`coordination-engine.ts:1446`）会被卡住。

**修法**：只在锁内做状态变更（lines 1426–1440 的 read-modify-write），出锁后再 await `ensureRunning`。本 PR 的 `deliverDispatchIntent` 现在是这个形状。

安全性论证：
- `ensureRunning` 自身幂等（`InlineRoleLoopRunner.ensureRunning` 在 `inline-role-loop-runner.ts:72-77` 通过 `activeRuns.has(runKey)` 短路）。
- 锁释放后任何争抢 `dispatchDeliveryMutex(edgeId)` 的 caller（abandon、replay）都会重新读 edge state，按 edge 当前状态走自己的分支；不依赖 first 的 `ensureRunning` 完成。
- 关键不变量：**至多一个 caller 真正进入 role loop body**——不论是 first 的 ensureRunning 先到，还是 replay 的 ensureRunning 先到。`activeRuns.has` 决定谁是 "first"，剩下的都立即 return。

### R2 — `flowStartIntentMutex` 用 `intentId` 而不是 `threadId`（不修，**只记录**）

`materializeFlowStartIntent` 锁 key 是 `intent.intentId`（`coordination-engine.ts:1375`）。这意味着：
- ✅ 同一 intent 不会被重复 materialize（outbox replay 安全）。
- ❌ **同一 thread 多个 ingress intent 可以并发 materialize**——例如用户连续发两条消息，两个 `FlowStartIntent.intentId` 不同，就并行进 message append → flow create → dispatch。

是否要"per-thread FIFO"是产品语义题，不是并发 bug：
- 如果产品语义要求一个 thread 的两条用户消息严格串行处理，那需要新加 `threadIngressMutex(threadId)`。
- 如果允许并发（当前默认），目前的 `flowMutex(flowId)` + `appendIfAbsent` + flow `expectedVersion` 已经守住"消息不丢、flow 不串、不重复 dispatch"。

**本 PR 不改这件事，留给 R2 follow-up**。新增的回归测试（§7）会给出"同 thread 并发 user post 的当前行为快照"，让未来谁要改 per-thread FIFO 时知道改了什么。

### R3 — `dispatchToRole` 里 `summaryBuilder.getRecentMessages` 影响 dispatch latency（**不修**）

不是阻塞性问题，只是慢。如果 summary 取慢，dispatch 慢，但其他 flow 不受影响（不在 flowMutex 内）。可以接受。

### R4 — `putFlow` 的 `expectedVersion` CAS 必须被未来任何 queue 形态尊重（**约束**）

`putFlow`（`coordination-engine.ts:1714`）已用 `expectedVersion: flow.version ?? 0`。如果未来真的把 `withFlowLock` 拆成事件队列，**绝不能丢掉这个 CAS**——它是当前并发安全的最后一道防线。

## 6. 未来 queue model 的边界（不在本 PR）

如果将来要正式化 queue model，建议按这个边界做，而不是"整个 coordination engine queue 化"：

1. **正式化现有三类 intent**：把 `FlowStartIntent` / `DispatchDeliveryIntent` / `RoleOutcomeIntent` 提到 contract 文档级别，写明每类的 idempotency key、lock key、replay 语义。
2. **per-thread FIFO 决策**：用回归测试证明产品需要 per-thread 顺序后，再加 `threadIngressMutex`。
3. **queue 化的边界是 intent dispatch，不是 flow 状态**：`flowMutex` 应该保留——它守的是 FlowLedger 的 read-modify-write，这是同步 CAS，天然适合 mutex，不适合 queue。

## 7. 本 PR 的具体动作

实际落地的范围比最初计划的窄，原因见每条说明：

1. **写本文档**（你正在读）。
2. **一处代码改动**：`deliverDispatchIntent` 把 `ensureRunning` 移出 `dispatchDeliveryMutex`。
3. **加 2 条 coordination-engine 回归测试**到 `coordination-engine.test.ts`：
   - **outbox-driven dispatch path coverage**：通过 `dispatchOutboxRootDir` 配置走真正的 `deliverDispatchIntent` 路径，验证 lock-protected work（enqueue + markHandoffDelivered）+ ensureRunning 信号都被触发。锁释放时机的差异（R1 修法的核心）通过代码 diff + 内联注释验证，**不通过单测的行为差异验证**——理由见下。
   - **R2 行为快照**：同 thread 并发两个 user post → 两条消息都持久化、产生两个独立 flow、各自 dispatch lead 一次。

**没做的测试 + 原因：**

- **同 flow 并发 shard reply → merge 只触发一次**：需要构造 fan-out + shard group 状态机 fixture，单 PR 范围太大。已有的 fan-out 测试在 `coordination-engine.test.ts:3490` 起覆盖了相关路径，单线程 happy path。
- **dispatch intent / role outcome replay 不重复 enqueue/close edge**：这是现有 `dispatchDeliveryMutex` / `roleOutcomeIntentMutex` 的语义。outbox 自身的 claim/lease 也已守住——本 PR 不引入新的 replay 风险，单写专用测试边际收益不大；如果未来真要补，正确位置在 outbox shipper 层级，不在 coordination engine。
- **role loop 长跑时 abandon path 不被阻塞**：这是 R1 修法的本质收益，但触发 abandon 路径需要让 outbox shipper dead-letter，这要么 mock 整套 shipper 行为（脆弱），要么需要 expose mutex（污染 API）。当前以 R1 的源码 diff + 安全性论证（§5）作为变更证明；未来如果做 outbox shipper 单测，可以在那里直接验证。

## 8. 之后再谈

- per-thread FIFO（R2）：等真实产品 case 提出"同 thread 串行"需求再做。
- 三类 intent 的正式 contract：可以单开 `docs/design/coordination-intent-contracts.md`，但没必要在 P1.4a 内做。
- 整体 queue 化：参见 §6——只在 dispatch 边界做，不要碰 flow CAS。
