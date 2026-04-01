# Runtime Observability Support v1

> 更新日期：2026-03-31
> 目标：在不引入完整 tracing 平台的前提下，为当前 runtime 增加统一的 execution-chain observability 支撑
> 约束：不替换现有 replay / recovery / operator / flow 体系；先把它们收成一条链，再决定是否需要更重的 tracing substrate

---

## 1. 这份设计解决什么问题

当前系统已经具备：

- `FlowLedger`
- `DispatchEnvelope`
- `RoleRunState`
- `ReplayRecord`
- `RecoveryRun`
- `BrowserSessionRuntime`
- `OperatorSummary / OperatorAttention`

但这些对象仍然更像：

- 多个分面
- 多个投影
- 多个局部链

而不是一条统一的 execution chain。

当前最真实的问题不是“没有日志”，而是：

1. 没有统一 root chain
2. 没有统一 parent/child execution relation
3. 没有统一 progress/heartbeat substrate
4. 没有 canonical chain-status query

这会导致系统虽然“能解释很多局部”，但还不能稳定回答：

> 这条执行链现在到底卡在哪一层？

---

## 2. 设计目标

Runtime Observability Support v1 只做 4 件事：

1. 定义统一的 execution chain 连接器
2. 定义统一的 runtime progress event
3. 定义统一的 chain status projection
4. 提供统一的 query/tail surface

它**不做**：

1. 完整 OpenTelemetry/trace backend
2. 替换现有 replay store
3. 替换 recovery run
4. 替换 operator summary
5. end-user UI 重做

---

## 3. 设计原则

### 3.1 Session-first, not tracing-first

先把 execution chain 建在现有 runtime/session 对象上，而不是先发明独立 tracing 图。

### 3.2 Append-only events, projected status

执行中信号一律先追加事件，再由 projection 生成“当前状态”。

### 3.3 Replay stays, chain becomes canonical glue

`ReplayRecord` 继续保留，它是事后诊断投影；  
`RuntimeChain` 负责成为跨 flow/role/worker/browser/recovery 的粘合层。

### 3.4 Operator-first surface now, UI later

第一阶段先服务：

- daemon
- TUI
- operator summary / attention

不强行做 end-user UI 嵌入。

---

## 4. 最小模型

## 4.1 `RuntimeChain`

```ts
type RuntimeChain = {
  chainId: string;
  threadId: ThreadId;
  rootKind: "flow" | "task" | "recovery";
  rootId: string;
  flowId?: FlowId;
  taskId?: TaskId;
  roleId?: RoleId;
  createdAt: number;
  updatedAt: number;
};
```

说明：

- 一条 root execution chain 对应一个顶层任务链
- 第一阶段不要求 chain 覆盖所有 UI 会话，只覆盖执行链

## 4.2 `RuntimeChainSpan`

```ts
type RuntimeSpanKind =
  | "flow"
  | "dispatch"
  | "role_run"
  | "worker_run"
  | "browser_session"
  | "replay_group"
  | "recovery_run";

type RuntimeChainSpan = {
  spanId: string;
  chainId: string;
  parentSpanId?: string;
  subjectKind: RuntimeSpanKind;
  subjectId: string;
  threadId: ThreadId;
  flowId?: FlowId;
  taskId?: TaskId;
  roleId?: RoleId;
  workerType?: WorkerKind;
  createdAt: number;
  updatedAt: number;
};
```

说明：

- 这里的 `span` 是最小 runtime 节点，不追求 tracing 标准兼容
- 重点是 parent/child relation 能把现有对象串起来

## 4.3 `RuntimeChainEvent`

```ts
type RuntimeChainPhase =
  | "started"
  | "heartbeat"
  | "waiting"
  | "completed"
  | "failed"
  | "degraded"
  | "cancelled";

type RuntimeChainEvent = {
  eventId: string;
  chainId: string;
  spanId: string;
  parentSpanId?: string;
  threadId: ThreadId;
  subjectKind: RuntimeSpanKind;
  subjectId: string;
  phase: RuntimeChainPhase;
  recordedAt: number;
  summary: string;
  statusReason?: string;
  artifacts?: {
    replayId?: string;
    recoveryRunId?: string;
    browserSessionId?: string;
    browserTargetId?: string;
    dispatchTaskId?: TaskId;
  };
  metadata?: Record<string, unknown>;
};
```

说明：

- 这是第一阶段真正的 append-only substrate
- heartbeat 不是定时器系统，而是：
  - 关键阶段推进时主动打点
  - 长执行节点也可显式补 heartbeat
- 当前实现还额外带：
  - `progressKind`
  - `heartbeatSource`
  - `responseTimeoutAt`
  - `reconnectWindowUntil`
  - `closeKind`

## 4.4 `RuntimeChainStatus`

```ts
type RuntimeChainStatus = {
  chainId: string;
  threadId: ThreadId;
  activeSpanId?: string;
  activeSubjectKind?: RuntimeSpanKind;
  activeSubjectId?: string;
  phase: RuntimeChainPhase | "resolved";
  canonicalState?: RuntimeChainCanonicalState;
  continuityState?: RuntimeContinuityState;
  continuityReason?: string;
  responseTimeoutAt?: number;
  reconnectWindowUntil?: number;
  closeKind?: RuntimeCloseKind;
  waitingReason?: string;
  stale?: boolean;
  staleReason?: string;
  latestSummary: string;
  lastHeartbeatAt?: number;
  lastCompletedSpanId?: string;
  lastFailedSpanId?: string;
  latestChildSpanId?: string;
  currentWaitingSpanId?: string;
  currentWaitingPoint?: string;
  attention: boolean;
  caseKey?: string;
  caseState?: OperatorCaseState;
  headline?: string;
  nextStep?: string;
  updatedAt: number;
};
```

说明：

- 这是统一查询面的最小状态对象
- 当前 detail/query 还会用最新 progress echo/control-path 事件刷新活态判断，
  所以 stale/degraded 不再只依赖 status store 的时间戳
- 永远回答：
  - 当前链在哪
  - 是否还活着
  - 现在是在等、跑、降级、失败还是结束

---

## 5. 和现有对象的映射

## 5.1 Root chain

第一阶段建议：

- `flowId` 存在时：`chainId = flow:<flowId>`
- 仅 recovery case：`chainId = recovery:<recoveryRunId>`
- 仅 task 无 flow：`chainId = task:<taskId>`

优先顺序：

1. `flowId`
2. `recoveryRunId`
3. `taskId`

## 5.2 Span 映射

建议先映射 6 类：

1. `dispatch`
   - 来源：`HandoffEnvelope.taskId`

2. `role_run`
   - 来源：`RoleRunState.runKey`

3. `worker_run`
   - 来源：worker `runKey`

4. `browser_session`
   - 来源：browser `sessionId`

5. `replay_group`
   - 来源：`ReplayTaskSummary.groupId`

6. `recovery_run`
   - 来源：`RecoveryRun.recoveryRunId`

## 5.4 Progress / State 补充对象

当前实现已补：

1. `RuntimeProgressEvent`
   - thread-scoped / chain-scoped 持久化
   - 由 role / worker / browser / recovery 主链发布

2. `runtime.state`
   - 由 coalesced state recorder 发布到 team event bus
   - 用于跨面观察“当前链处于什么状态”

3. `ThreadSessionMemory`
   - 由 context maintainer 持续更新
   - 承载：
     - active tasks
     - open questions
     - recent decisions
     - constraints
     - continuity notes
     - latest journal entries

4. `SerialBatchUploader / CoalescingStateUploader`
   - 为 progress/state 传播提供 bounded queue 与 coalescing 基础

## 5.3 Parent/child relation

第一阶段建议：

- `dispatch -> role_run`
- `role_run -> worker_run`
- `worker_run -> browser_session`
- `replay_group -> recovery_run`
- `recovery_run -> replay_group` follow-up 通过 artifact linkage 而不是环状 parent

约束：

- 不强求一开始构建完美 DAG
- 先保证“主链父子关系”成立

---

## 6. 事件来源

第一阶段只接 5 类来源：

1. `scheduled / dispatch`
2. `role runtime`
3. `worker runtime`
4. `browser session runtime`
5. `recovery runtime`

---

## 7. 当前实现状态

当前版本已覆盖：

1. 持久化 root chain
   - `flow -> dispatch`

2. 派生 chain
   - `recovery -> replay_group`

3. live augmentation
   - `role_run -> worker_run -> browser_session`

4. live progress
   - role
   - worker
   - browser
   - recovery action path

5. coalesced runtime state publication
   - flow chain status
   - recovery status transition

6. session continuity memory
   - 后台更新
   - retrieval 可召回

7. 查询面
   - `GET /runtime-chains`
   - `GET /runtime-active`
   - `GET /runtime-summary`
   - `GET /runtime-waiting`
   - `GET /runtime-failed`
   - `GET /runtime-progress`
   - `GET /runtime-chains/:id`
   - `GET /runtime-chains/:id/events`
   - `GET /runtime-chains/:id/progress`
   - `GET /context/session-memory`

对应 TUI：

- `runtime-chains`
- `runtime-active`
- `runtime-summary`
- `runtime-waiting`
- `runtime-failed`
- `runtime-chain`
- `runtime-chain-events`
- `runtime-progress`
- `runtime-chain-progress`
- `session-memory`

当前仍保留的边界：

1. role / worker / browser / recovery 已补 long-running heartbeat，但更细的 compact/transition 边界仍可继续深化
2. session memory 已走 durable background refresh worker，后续如果出现独立外部 memory service 再继续沿同一 job/outbox 形态扩展
3. uploader/backpressure 已支持 retry/backoff/drop 与 file-backed remote outbox；后续只需在真实外部 sink 部署时接上远端传输端点

### 6.1 Dispatch

事件：

- `started`
- `waiting`
- `completed`
- `failed`

### 6.2 Role run

事件：

- `started`
- `heartbeat`
- `waiting`
- `completed`
- `failed`

heartbeat 触发点：

- dequeue 后
- handoff 完成前
- worker 等待态切换时
- long-running tick

### 6.3 Worker run

事件：

- `started`
- `heartbeat`
- `completed`
- `degraded`
- `failed`

### 6.4 Browser session

事件：

- `started`
- `heartbeat`
- `waiting`
- `completed`
- `failed`
- `degraded`

heartbeat 触发点：

- `spawn/send/resume`
- `open/navigate/snapshot/act/screenshot/console`
- fallback / reconnect / reopen

### 6.5 Recovery run

事件：

- `started`
- `waiting`
- `heartbeat`
- `completed`
- `failed`
- `cancelled`

说明：

- 现有 `RecoveryRunEvent` 不替换
- 只需要同步投影成 runtime chain event

---

## 7. 持久化层

## 7.1 `RuntimeChainStore`

```ts
interface RuntimeChainStore {
  get(chainId: string): Promise<RuntimeChain | null>;
  put(chain: RuntimeChain): Promise<void>;
  listByThread(threadId: ThreadId): Promise<RuntimeChain[]>;
}
```

第一阶段落盘：

- `runtime-chains/by-id/<chain>.json`
- `runtime-chains/threads/<thread>/<chain>.json`

## 7.2 `RuntimeChainSpanStore`

```ts
interface RuntimeChainSpanStore {
  get(spanId: string): Promise<RuntimeChainSpan | null>;
  put(span: RuntimeChainSpan): Promise<void>;
  listByChain(chainId: string): Promise<RuntimeChainSpan[]>;
}
```

第一阶段落盘：

- `runtime-chain-spans/by-id/<span>.json`
- `runtime-chain-spans/chains/<chain>/<span>.json`

## 7.3 `RuntimeChainEventStore`

```ts
interface RuntimeChainEventStore {
  append(event: RuntimeChainEvent): Promise<void>;
  listByChain(chainId: string, limit?: number): Promise<RuntimeChainEvent[]>;
}
```

第一阶段落盘：

- `runtime-chain-events/by-chain/<chain>.json`

说明：

- 第一阶段先用“按 chain 聚合文件”实现 append-only 语义
- 不急着做独立 event tail/index store

## 7.4 `RuntimeChainStatusStore`

```ts
interface RuntimeChainStatusStore {
  get(chainId: string): Promise<RuntimeChainStatus | null>;
  put(status: RuntimeChainStatus): Promise<void>;
  listByThread(threadId: ThreadId): Promise<RuntimeChainStatus[]>;
  listActive(limit?: number): Promise<RuntimeChainStatus[]>;
}
```

第一阶段落盘：

- `runtime-chain-status/by-id/<chain>.json`
- `runtime-chain-status/threads/<thread>/<chain>.json`

---

## 8. 查询面

第一阶段最小 daemon surface：

- `GET /runtime-chains?threadId=...`
- `GET /runtime-chains/:id`
- `GET /runtime-chains/:id/events`
- `GET /runtime-active`
- `GET /runtime-summary`
- `GET /runtime-waiting`
- `GET /runtime-failed`

第一阶段最小 TUI：

- `runtime-chains`
- `runtime-chain <chainId>`
- `runtime-chain-events <chainId>`
- `runtime-active`
- `runtime-summary`
- `runtime-waiting`
- `runtime-failed`

这组接口必须能回答：

1. 当前 active chain 是谁
2. 当前 active span 是谁
3. 当前 phase 是谁
4. 最近 heartbeat 是谁
5. 当前等待点是什么
6. 当前有哪些链处于 `open / heartbeat / waiting / degraded / failed / resolved`
7. 哪些链已经 stale，以及为什么 stale
8. 这条 runtime chain 对应哪个 case，下一步建议是什么

---

## 9. 与现有系统的关系

## 9.1 Replay

`ReplayRecord` 继续保留。  
它仍然是：

- 事后诊断
- failure analysis
- incident / bundle / recovery 的基础

但：

- replay 不是 execution chain substrate 本身
- replay 应成为 chain 的一条投影

## 9.2 Recovery

`RecoveryRun` 继续保留。  
它已经是非常强的恢复对象。

新增关系：

- recovery run 作为 chain/span 的 subject
- `RecoveryRunEvent` 同步投影到 `RuntimeChainEvent`

## 9.3 Operator

`OperatorSummary / OperatorAttention` 不替换。  
后续只需要改成从：

- flow
- replay
- recovery
- runtime chain status

共同派生，而不是只从前三者拼装。

---

## 10. 接线顺序

不建议大爆炸。

### 阶段 A：只接 root chain + status

1. 为 dispatch/flow 建 root `chainId`
2. 建 status projection
3. 提供最小 `/runtime-chains`

目标：

- 先能知道“当前整条链在哪”

### 阶段 B：接 role / worker / browser

1. role run 进链
2. worker run 进链
3. browser session 进链
4. 加最小 heartbeat

目标：

- 先能知道“当前在哪一层运行”

### 阶段 C：接 recovery / replay

1. recovery run 进链
2. replay group 进链
3. chain query 与 operator summary 对齐

目标：

- 让失败和恢复也属于同一条 execution chain

### 阶段 D：接 canonical runtime mix + stale / case projection

1. `runtime-summary / runtime-waiting / runtime-failed`
2. canonical `open / heartbeat / waiting / degraded / failed / resolved`
3. stale detection
4. case correlation：`caseKey / caseState / headline / nextStep`

目标：

- 让 runtime query 面直接成为 operator 首页级入口，而不是旁路调试视图

---

## 11. Acceptance line

Runtime Observability Support v1 完成后，系统至少必须稳定回答：

1. 这条执行链的 root 是谁
2. 当前 active span 是谁
3. 系统是还在跑、在等、在恢复、在降级，还是已经结束
4. 最后一个完成的 child span 是谁
5. 当前等待点是什么
6. 这条链是否已经 stale
7. 这条链映射到哪个 case
8. 下一步建议动作是什么

如果这 8 个问题不能稳定回答，就不算完成。

---

## 12. 当前最准确的定位

一句话总结：

`Runtime Observability Support v1` 不是要把系统变成 tracing 平台。  
它要做的是：

**把现有 Flow / Replay / Recovery / Browser / Operator 收成一条统一 execution chain。**

等这条链稳定以后，再考虑是否需要更重的 tracing substrate，才是合理顺序。
