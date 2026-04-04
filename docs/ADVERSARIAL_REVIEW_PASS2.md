# TurnkeyAI 第二轮对抗性架构审查

> 审查日期：2026-04-04  
> 审查目标：仅关注长时运行、browser workflow、故障恢复、operator 调试和未来扩展场景下的结构性风险  
> 审查方法：逐题作答，每条结论必须有文件/行号/符号级证据

---

## 1. 系统依赖但未强制执行的 5 个不变量

### 不变量 1：flow 和 message 的因果一致性

**假设：** 每个 flow 的 `rootMessageId` 对应的 message 一定已经存在于 `teamMessageStore` 中。  
**违反路径：** `CoordinationEngine.handleUserPost()` 先 `append(userMessage)` 再 `putFlow(flow)`（`coordination-engine.ts` L84-88）。如果 `putFlow` 成功但进程在 `dispatchToLead` 前崩溃，会产生"有 flow 但后续 handoff 未建立"的孤儿 flow。反过来，如果 `append` 成功但 `putFlow` 失败，会产生"有 message 但没有 flow"的悬挂消息。  
**后果：** recovery 系统 (`loadRecoveryRuntime`) 遍历 replay records 按 `taskId` 分组时会找不到对应 flow，导致 recovery plan 的 `flowId` 为空，进而 `executeRecoveryRunAction` 在 `syncedRun.roleId` 检查时报 409。  
**未执行之处：** 没有启动时 orphan flow/message 检测，没有 compensating transaction。

### 不变量 2：worker session 在 recovery resume 时存在

**假设：** 当 `continuityMode: "resume-existing"` 被设置时（`scheduled-task-runtime.ts` → `coordination-engine.ts` L930-975），`workerRuntime.getState(workerRunKey)` 能返回有效的 `WorkerSessionState`。  
**违反路径：** `InMemoryWorkerRuntime` 使用纯内存 `Map`（`in-memory-worker-runtime.ts` L33）。进程重启后 `getState()` 返回 `null`。`PolicyRoleRuntime.resolveExistingWorker()` 在 worker state 不存在时 fallback 到 `spawn()`——这看似安全，但 recovery dispatch 构建的 `ScheduledTaskRecord` 中 `browserSession.leaseHolderRunKey` 指向已不存在的 `workerRunKey`，导致 browser session lease claim 失败。  
**后果：** recovery 声称 "auto_resume" 但实际执行了一次 cold start，browser session 上下文丢失。operator 看到 "recovered" 但实际执行路径与预期不符。  
**未执行之处：** `resolveScheduledContinuationContext` 在 `workerRunKey` 存在但 `getState` 返回 null 时静默 fallback，无日志、无 replay 标记。

### 不变量 3：InlineRoleLoopRunner 的 activeRuns 防重入

**假设：** 同一 `runKey` 不会并发执行两次 `ensureRunning()`。  
**违反路径：** `activeRuns` 是一个纯内存 `Set<RunKey>`（`inline-role-loop-runner.ts` L57）。防重入检查 (`this.activeRuns.has(runKey)`) 在 L73 发生。但如果两个并发的 handoff enqueue 几乎同时触发 `ensureRunning()`，且第一个调用已进入 `while(true)` 循环在 `await roleRuntime.runActivation()` 处阻塞——第二个调用的 `has(runKey)` 检查在 `add` 之后，所以不会重入。这里的防护**生效的**。  
**真正的问题：** 进程重启后 `activeRuns` 清空，但 `roleRunStore` 中仍有 `status: "running"` 的 run。重启后无人再次调用 `ensureRunning()`，导致 inbox 中的 handoff 永远不会被消费。  
**未执行之处：** 没有"启动时扫描 running/queued role runs 并重新 dispatch"的机制。

### 不变量 4：RuntimeChainStatus 与 FlowLedger 状态同步

**假设：** `RuntimeChainStatus` 始终反映 `FlowLedger` 的最新状态。  
**违反路径：** `CoordinationEngine.putFlow()` 调用 `runtimeChainRecorder.syncFlowStatus(flow)` 是 best-effort 的（`coordination-engine.ts` L1057-1060）。如果 `syncFlowStatus` 抛异常，`putFlow` 仍然成功（因为 `recordRuntimeChainBestEffort` catch + console.error，L1062-1077）。之后 `loadRuntimeChainEntriesForThread()` 读取 `runtimeChainStatusStore` 时会得到旧状态。  
**后果：** `operator-triage` / `runtime-summary` / `runtime-attention` 页面显示的 chain 状态与 flow 实际状态不一致。在极端情况下，一个已完成的 flow 在 runtime chain 视图中仍然显示 "waiting"，触发误报 attention。  
**未执行之处：** 没有 "定期校对 flow 状态与 chain 状态" 的 reconciler。

### 不变量 5：时钟一致性

**假设：** 所有 `recordedAt`、`createdAt`、`updatedAt`、`responseTimeoutAt` 字段来自同一个时间源。  
**违反路径：** `InlineRoleLoopRunner.recordRoleProgress()` 使用裸 `Date.now()`（`inline-role-loop-runner.ts` L231, L243, L245, L249），但 `CoordinationEngine` 使用注入的 `this.deps.clock.now()`，`InMemoryWorkerRuntime` 使用注入的 `this.now()`，`BrowserSessionManager` 使用注入的 `this.now()`。  
**后果：** 当测试或未来跨进程部署中 clock 被 mock 或偏移时，progress events 的 `recordedAt` 与 flow 的 `updatedAt` 可能不一致，导致 `decorateRuntimeChainStatus()` 中的 timeout/stale 检测出现误判。  
**未执行之处：** `InlineRoleLoopRunner` 不接受 `Clock` 注入。

---

## 2. 最危险的 5 个架构瓶颈文件

### 文件 1：`packages/app-gateway/src/daemon.ts`（3452 行）

**瓶颈性质：** 同时承担 composition root + HTTP 路由 + recovery orchestration + runtime query + relay protocol + browser session routing + validation runner routing。所有新功能必须触碰此文件。  
**将阻塞什么：** 任何新 worker 类型、任何新 operator surface、任何 API 版本变更、任何 auth 模型变更。  
**证据：** `executeRecoveryRunAction()` L2790-3139（350 行），`loadRuntimeChainEntriesForThread()` L2328-2413（85 行），browser session 路由 L1497-1698（200 行），relay 路由 L1700-1865（165 行），validation/soak/regression 路由 L1080-1260（180 行）。

### 文件 2：`packages/core-types/src/team.ts`（2442 行）

**瓶颈性质：** 仓库中每一个包都 `import from "@turnkeyai/core-types/team"`。任何类型变更影响全仓库编译。新领域概念（如 coder worker、remote execution envelope）必须添加到这个已有 2442 行的文件中。  
**将阻塞什么：** 新 worker kind 的类型定义会进一步膨胀此文件。当 `WorkerKind` union 扩展、`ScheduledTaskRecord` 增加新字段、`RecoveryRun` 增加新状态时，每次都是全文件级变更。

### 文件 3：`packages/team-runtime/src/coordination-engine.ts`（1367 行）

**瓶颈性质：** 所有 flow 调度逻辑的唯一入口。handleUserPost / handleScheduledTask / handleRoleReply / onRoleFailure / dispatchToRole / applyRecoveryDecision / handleFanOutMerge / handleFanOutFailure 全在同一个类中。  
**将阻塞什么：** 新的 dispatch 模式（如 typed delegation、work package）、新的 parallel orchestration 策略、新的 recovery decision 路径。

### 文件 4：`packages/role-runtime/src/policy-role-runtime.ts`（1004 行）

**瓶颈性质：** `runActivation()` 是一个 155 行的方法，同时负责 worker spawn/send/resume 选择 + governance 评估 + evidence 持久化 + event 发布 + replay recording + response generation + message 构建。  
**将阻塞什么：** 新的 governance 策略、新的 worker 交互模式（如 multi-step tool chain）、prompt injection defense。

### 文件 5：`packages/worker-runtime/src/in-memory-worker-runtime.ts`（507 行）

**瓶颈性质：** 这是唯一的 `WorkerRuntime` 实现。所有 worker session state 存在此文件的 `Map` 中。当需要支持 persistent workers、remote workers、durable execution 时，这个文件必须被替换或重写。  
**将阻塞什么：** crash recovery、multi-process worker 分配、worker session 持久化、任何需要跨进程查看 worker 状态的 operator surface。

---

## 3. 假装有 durable execution 但实际只有 resumability heuristic 的位置

### 位置 1：recovery dispatch 的 "auto_resume" 路径

`daemon.ts` L3294: `"Continue from the latest live continuation context and finish the interrupted work."`

实际发生的是：`buildRecoveryDispatchTask()` 构建一个 `ScheduledTaskRecord`（L3208-3281），传入 `coordinationEngine.handleScheduledTask()`（L3005），后者创建一个新 flow + 新 message + 新 handoff。这是一次**全新的 flow 执行**，不是从断点恢复。"continuation context" 是一段自然语言字符串注入 prompt，不是可执行的 checkpoint。

**证据：** `buildRecoveryInstructions()` L3283-3304 生成的是一段人类可读的 instruction 文本，而非任何结构化的 execution state snapshot。

### 位置 2：worker "resume-existing" 语义

`in-memory-worker-runtime.ts` L186-204: `resume()` 方法检查 session status 后调用 `this.send()`——实际上是重新执行 handler，不是从执行断点恢复。`buildResumePacket()` L469-491 通过在 `taskPrompt` 末尾追加 continuation context 文本来实现 "resume"——这是 prompt engineering，不是 durable execution。

**证据：** `buildResumePacket` 的输出是 `{ ...packet, continuityMode: "resume-existing", taskPrompt: \`${packet.taskPrompt}\n\n${continuationLines.join("\\n")}\` }`——纯文本拼接。

### 位置 3：browser session "hot/warm/cold" resume 分类

`BrowserSessionManager.resumeSession()` 返回一个 `BrowserSessionLease`，但 resume mode 分类 (`hot | warm | cold`) 是在 transport adapter 层事后标注的——不是 session manager 主动选择恢复策略。session manager 只做 lease claim，实际的 target reconnect 或 reopen 完全由 transport adapter 自行决定。

**证据：** `browser-session-manager.ts` `resumeSession()` L132-145 只调用 `claimSessionLease()`，不涉及任何 target 状态检查或恢复策略选择。

### 位置 4：RuntimeChainStatus 的 continuityState

`RuntimeChainStatus` 有 `continuityState: "alive" | "waiting" | "reconnecting" | "transient_failure" | "terminal" | "resolved"`（`team.ts` L123-129），看似是 durable execution 状态机。但实际上这个字段是由 progress events **追加标注**的（`decorateRuntimeChainStatus()` in `runtime-chain-inspection.ts`），而不是由 execution runtime 驱动的状态转换。没有任何 runtime 逻辑根据 `continuityState` 做分支决策。

**证据：** 全仓库 grep `continuityState` 在非 test/non-type 文件中，只在 progress recording（追加标注）和 inspection/decoration（读取展示）中出现，从未在 dispatch/resume/recovery decision 逻辑中被条件判断。

---

## 4. Replay / Recovery / Operator Summary 与真实运行时状态不一致的位置

### 不一致 1：RecoveryRun 状态是从 replay records 推断的

`loadRecoveryRuntime()` (`daemon.ts` L2307-2318) 调用 `buildRecoveryRuns(records, stabilizedRuns, clock.now())`。`buildRecoveryRuns` 通过匹配 replay records 的 `taskId`/`replayId` 与 recovery run 的 `sourceGroupId`/`dispatchedTaskId` 来推断 run 是否已 recovered。如果 replay record 写入延迟或失败（`runBestEffort` 在 `policy-role-runtime.ts` L206-210 对 replay recording 使用 best-effort），recovery run 状态会停留在 "running" 即使实际 flow 已完成或失败。

### 不一致 2：operator-triage 重复计算导致瞬态不一致

`daemon.ts` L923-981: `/operator-triage` 端点并行加载 flows + permissions + events + recovery runtime + progress events + runtime summary，然后串行构建 operator summary → operator attention → triage report。在两次 `buildOperatorSummaryReport` 和 `buildOperatorAttentionReport` 调用之间（L932-971），底层数据可能已发生变化（新 flow 完成、新 recovery event 产生），导致 summary 和 attention 的数据基础不一致。

### 不一致 3：runtime chain status 的 stale 检测是快照式的

`decorateRuntimeChainStatus()` 在 `runtime-chain-inspection.ts` 中根据 `responseTimeoutAt` 和当前时间判断 chain 是否 stale。但这个判断只在 HTTP 请求时计算，不是持续监控。一个 chain 可能在 15 分钟前就已经 stale，但直到 operator 下次查询时才被标记。在此期间 `runtime-attention` 视图不会展示任何警报。

### 不一致 4：browser continuity summary 从 replay metadata 提取的 session/target 可能已 stale

`extractReplayBrowserContinuity()` 从 replay record 的 metadata 中提取 `sessionId` / `targetId` / `transportMode`。但这些信息反映的是 replay 记录时的状态——session 可能已被 evict（`evictIdleSessions`），target 可能已 close。operator 看到的 browser continuity summary 显示 "stable"，但实际 session 已不存在。

### 不一致 5：recovery run progress 的 "recovered" 判定

`findRecoveryRun()` 在 `replay-inspection.ts` 中通过检查 follow-up replay records 的状态来判定 recovery run 是否 recovered。如果 follow-up flow 的 replay record 标记为 "completed" 但该 flow 实际上是一个不相关的新用户消息（恰好命中了相同的 `sourceGroupId` 匹配逻辑），recovery run 会被错误地标记为 "recovered"。

---

## 5. Daemon / Runtime / Store / Browser Transport 之间的隐藏耦合点

### 耦合 1：daemon.ts 直接使用 store 实例构造 runtime 查询

`loadRuntimeChainEntriesForThread()` (`daemon.ts` L2328-2413) 直接访问 `runtimeChainStore`、`runtimeChainStatusStore`、`runtimeProgressStore`、`flowLedgerStore`、`roleRunStore`、`workerRuntime.getState()`、`replayRecorder.list()`。这不是通过运行时接口调用，而是 daemon 直接持有所有 store 引用并自行组装查询。任何 store schema 变更直接影响 daemon。

### 耦合 2：CoordinationEngine 知道 browser session payload 的编解码

`coordination-engine.ts` L47: `import { decodeBrowserSessionPayload }`. `resolveScheduledContinuationContext()` L954 直接解码 worker result payload 中的 browser session 信息。Team runtime 层应不知道 browser transport 的 payload 格式。

### 耦合 3：recovery dispatch 路径绕过 runtime 抽象直接操作 store

`executeRecoveryRunAction()` (`daemon.ts` L2790-3139) 直接写入 `recoveryRunStore.put()`、`recoveryRunEventStore.append()`、`replayRecorder.record()`、`runtimeProgressRecorder.record()`——这些操作混合了 store 写入和 runtime 进度记录，且没有封装在任何 runtime service 中。如果 recovery run 的 store schema 变更，daemon.ts 的 350 行 recovery action 逻辑全部需要同步修改。

### 耦合 4：browser transport adapter 类型通过 downcast 暴露

`daemon.ts` L362: `const relayGateway = maybeGetRelayGateway(browserBridge)` — 这通过运行时类型检查将 `BrowserTransportAdapter` downcast 到 `RelayBrowserAdapter`，打破了 transport 抽象。relay-specific 端点 (`/relay/peers`, `/relay/targets`) 直接调用 `relayGateway` 的方法，意味着 daemon 对 "当前使用哪种 transport" 有运行时依赖。

### 耦合 5：RuntimeChainRecorder 与 FlowLedger 的写入耦合

`CoordinationEngine.putFlow()` (`coordination-engine.ts` L1057-1060) 每次写入 flow 后立即调用 `runtimeChainRecorder.syncFlowStatus(flow)`。这意味着 `RuntimeChainRecorder` 的接口契约（`syncFlowStatus` 的输入形状）与 `FlowLedger` 的 schema 紧密耦合。如果 `FlowLedger` 新增字段影响 chain status 计算（如新的 `status` enum 值），`runtime-chain-recorder.ts` 中的 `buildRuntimeChainStatusFromFlow()` 必须同步更新。

---

## 6. 新增 worker 或 remote execution 时最先崩溃的抽象

### 抽象 1：`WorkerKind` 硬编码 union

```typescript
// team.ts L738
export type WorkerKind = SpawnedWorker["workerType"];
// team.ts L734
export interface SpawnedWorker {
  workerType: "browser" | "coder" | "finance" | "explore" | "harness";
  workerRunKey: RunKey;
}
```

新增 worker 类型需要修改 `SpawnedWorker.workerType` union → 影响 `WorkerKind` → 影响全仓库所有使用 `WorkerKind` 的 switch/if 分支（至少 20+ 处）。`inferPreferredWorkerKinds()` (`policy-role-runtime.ts` L830-851) 有硬编码的 capability → worker 映射。`buildDemoRoles()` (`daemon.ts` L1960-2050) 有硬编码的 demo worker 配置。

### 抽象 2：`WorkerHandler` 的同步单步执行模型

```typescript
// team.ts L2154-2158
export interface WorkerHandler {
  kind: WorkerKind;
  canHandle(input: WorkerInvocationInput): boolean | Promise<boolean>;
  run(input: WorkerInvocationInput): Promise<WorkerExecutionResult | null>;
}
```

`run()` 返回 `WorkerExecutionResult | null`——同步单步。remote execution 需要 `run()` 返回一个 handle 后异步等待结果，当前接口不支持。multi-step tool chain 需要 `run()` 多次 yield 中间结果，当前接口不支持。

### 抽象 3：`InMemoryWorkerRuntime` 的 session 模型

当前 worker session 完全绑定到本进程内存。remote worker 需要 session 在 worker 进程中维护而非在 daemon 中维护。当前的 `spawn → send → resume → interrupt → cancel` 生命周期假设 worker handler 在同一进程中执行。

---

## 7. 应在项目进一步增长前成为显式 domain contract 的数据结构

### 结构 1：`RelayPayload` → 应拆分为 `DispatchEnvelope`

当前 `RelayPayload` 同时包含旧字段和新结构化字段（`team.ts` L427-442），是过渡态。应固化为一个只有结构化路径的 `DispatchEnvelope`：`{ intent, continuity, coordination, constraints }`，删除所有顶层冗余字段。

### 结构 2：`ScheduledTaskRecord.dispatch` vs 顶层字段

`ScheduledTaskRecord` 同时有 `dispatch.targetRoleId` 和 `targetRoleId`、`dispatch.targetWorker` 和 `targetWorker`、`dispatch.sessionTarget` 和 `sessionTarget`（`team.ts` L2013-2036）。`getScheduledTargetRoleId()` 等 helper 做 fallback 读取。应固化 `dispatch` 为唯一来源，删除顶层冗余字段。

### 结构 3：`RecoveryRun` 的 `attempts` 数组 → 应成为独立的 `RecoveryAttempt` store

当前 `RecoveryRun.attempts: RecoveryRunAttempt[]` 嵌套在 run 对象内。每次 action 都 read-modify-write 整个 run 对象（包括所有历史 attempts）。随着 retry/fallback 链增长，单个 run 的 JSON 体积线性增长。应将 attempts 拆为独立 store。

### 结构 4：`RuntimeProgressEvent` → 应有显式 schema version

当前 `RuntimeProgressEvent` 有 20+ 个可选字段（`team.ts` L275-305），不同的 progress source（role / worker / browser / recovery / session-memory）写入不同的字段子集。没有 discriminant field 标明哪些字段是预期存在的。应增加 `kind: "role_progress" | "worker_progress" | "browser_progress" | "recovery_progress"` 并收窄可选字段。

### 结构 5：browser `BrowserContinuationHint` → 应成为 typed sealed contract

`BrowserContinuationHint`（`team.ts` L394-401）在 scheduled task dispatch、recovery dispatch、replay metadata 中被序列化/反序列化，但其 `resumeMode`、`ownerType`、`leaseHolderRunKey` 的有效性从未在反序列化端验证。应增加 runtime validation + 版本标记。

---

## 8. 应变为 append-only journal/event 的结构 vs 应保持为 projection 的结构

### 应变为 append-only journal

| 当前结构 | 原因 |
|---|---|
| `TeamMessage` (`FileTeamMessageStore`) | 消息天然是 append-only。当前的 read-all + push + write-all 是反模式。应改为 JSONL append。 |
| `RuntimeChainEvent` (`FileRuntimeChainEventStore`) | 已是 append-only。✅ 保持。 |
| `RecoveryRunEvent` (`FileRecoveryRunEventStore`) | 已是 append-only。✅ 保持。 |
| `RuntimeProgressEvent` (`FileRuntimeProgressStore`) | 已是 append-only。✅ 保持。 |
| `TeamEvent` (`InMemoryTeamEventBus`) | **应变为 append-only file**。当前纯内存，进程重启全部丢失。audit.logged events 是合规需求。 |
| `BrowserSessionHistoryEntry` | 已是 append-only。✅ 保持。 |
| `ThreadJournalRecord.entries` | 当前是 compacted array。应改为 append-only entries + compaction 在读取时做。 |

### 应保持为 projection（允许覆盖写）

| 当前结构 | 原因 |
|---|---|
| `FlowLedger` | flow 状态是可变的（status / activeRoleIds / edges state）。应保持 put-overwrite 语义，但增加版本号 (optimistic concurrency)。 |
| `RoleRunState` | role run 是可变状态机。保持 put-overwrite。 |
| `RuntimeChainStatus` | 这是 chain 状态的最新快照。保持 put-overwrite。 |
| `RecoveryRun` | recovery run 有丰富的状态转换。保持 put-overwrite，但 attempts 应拆为 append-only。 |
| `ThreadSummaryRecord` | 线程摘要是 compressor 的输出 projection。保持 put-overwrite。 |
| `ThreadSessionMemoryRecord` | session memory 是上下文的实时 projection。保持 put-overwrite。 |
| `BrowserSession` / `BrowserTarget` | 可变状态。保持 put-overwrite。 |

---

## 9. 减少未来复杂度/投入比最高的 3 个重构

### 重构 1：将 daemon.ts 拆分为 composition root + 路由模块 + recovery service

**投入：** 2-3 天  
**减少的复杂度：**
- 消除 3452 行的 god file，每个模块 < 300 行
- `executeRecoveryRunAction` 提取为 `RecoveryActionService`，独立可测试
- browser / relay / validation / scheduled task 路由各自独立
- 新增 API 端点不再需要理解整个 daemon

**执行顺序：**
1. 提取 `RecoveryActionService`（daemon.ts L2790-3452 → 新文件）
2. 提取 `RuntimeQueryService`（daemon.ts L2320-2576 → 新文件）
3. 按 domain 拆分路由到 `routes/` 目录
4. 保留 `daemon.ts` 仅做 composition + server.listen

### 重构 2：为 WorkerSessionState 增加 file-backed 持久化

**投入：** 3-5 天  
**减少的复杂度：**
- 消除 "worker state 在进程重启后丢失" 这个系统级不变量违反
- recovery resume 的 "auto_resume" 路径从 heuristic 提升为 credible
- operator 的 worker state 查询不再是纯内存快照
- 消除 `loadWorkerStatesByRunKey()` 在 daemon 中的 N+1 查询——可直接从持久化 store 读取

**执行顺序：**
1. 创建 `FileWorkerSessionStore` 实现 `WorkerSessionState` 的 get/put/listByThread
2. `InMemoryWorkerRuntime` 改为 write-through：每次 state 变更同时写内存 + file store
3. 进程启动时从 file store 恢复 sessions map
4. 增加 stale session 清理逻辑

### 重构 3：消除 RelayPayload / ScheduledTaskRecord 的字段重复

**投入：** 2-3 天  
**减少的复杂度：**
- 消除 `dispatchToRole()` 中每个字段写两次的 bug 风险
- 消除 `getScheduledTargetRoleId()` / `getScheduledTargetWorker()` 等 fallback helper 的存在理由
- 新增 dispatch 语义时只需修改一处
- 所有消费方统一使用结构化路径读取

**执行顺序：**
1. 在 `RelayPayload` 中标记旧字段为 `@deprecated`
2. 将所有读取方迁移到结构化路径（`intent` / `continuity` / `coordination` / `constraints`）
3. 删除旧字段和 fallback helper
4. 对 `ScheduledTaskRecord` 做同样操作

---

## 10. 作为维护者，在基础清理完成前拒绝构建的功能

### 拒绝 1：通用 subagent runtime v2

**理由：** 当前 `WorkerHandler.run()` 是同步单步模型，`InMemoryWorkerRuntime` 无持久化。在此基础上构建多层嵌套 subagent 只会放大所有现有问题——不可恢复的嵌套执行链、无法持久化的 subagent 中间状态、无法追踪的 progress chain。  
**前置条件：** Worker session 持久化 + WorkerHandler 接口支持异步多步 + daemon 拆分完成。

### 拒绝 2：Electron GUI

**理由：** 当前 operator surface 的数据基础（runtime chain status、replay console、operator triage）与真实运行时状态之间存在系统性不一致（见第 4 节）。在此基础上构建 GUI 只会把不一致的数据用更精美的方式展示给用户，放大误导风险。  
**前置条件：** RuntimeChainStatus reconciler + replay/recovery 状态与真实 flow 状态的一致性保证 + stale detection 从快照式改为持续式。

### 拒绝 3：Remote worker / multi-process execution

**理由：** 当前所有 concurrency 控制（KeyedAsyncMutex、InlineRoleLoopRunner.activeRuns、CoalescingStateUploader）都是进程内的。文件级 store 的锁也是进程内的。多进程下所有这些保证同时失效。  
**前置条件：** 文件级 store 改用文件锁或 SQLite + worker session 持久化 + ID 生成器改用 UUID + InMemoryTeamEventBus 持久化。

---

## 执行优先级建议

```
周 1-2: daemon.ts 拆分（重构 1）
         ├── RecoveryActionService 提取
         ├── RuntimeQueryService 提取
         └── 路由文件拆分

周 2-3: WorkerSessionState 持久化（重构 2）
         ├── FileWorkerSessionStore
         ├── write-through 改造
         └── 启动时恢复

周 3-4: 字段重复消除（重构 3）
         ├── RelayPayload 迁移
         ├── ScheduledTaskRecord 迁移
         └── fallback helper 删除

周 4-5: 不变量加固
         ├── InlineRoleLoopRunner 注入 Clock
         ├── InMemoryTeamEventBus 持久化
         ├── flow/message orphan detection at startup
         └── ID 生成器改 UUID
```

---

*本报告生成于 2026-04-04，专注于系统在长期运行、故障恢复和规模增长场景下的结构性风险。*
