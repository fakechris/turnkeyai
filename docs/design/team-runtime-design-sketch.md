# 自研 Team Runtime 设计草图

> 更新日期：2026-03-28
> 目标：把当前运行时研究结论收束成一套能直接落代码的自研协作运行时，并主动避开既有产品里的命名和实现缺陷

---

## 1. 设计目标

要做的不是“多人群聊 + @mention”的界面层，而是一套真正的协作执行层：

- `Team`
- `Role Runtime`
- `Mention-driven Handoff`
- `Worker Delegation`
- `QC / Recovery`
- `Execution Replay`

短期目标应满足：

1. 一个 team 里有多个固定角色。
2. `@mention` 触发串行或半串行接力。
3. 同一个角色可以被再次唤起，并复用已有上下文。
4. 角色内部可以继续派生 worker。
5. browser worker 作为角色附属能力运行，而不是 team 直接控制 browser。
6. 中途失败后仍能收敛到 lead role，而不是整条链断掉。

---

## 2. 必须保留的运行时边界

### 2.1 Team thread 是一等对象

不要把 team 当成普通会话外挂一个 `members[]`。

最少要显式建模：

- `teamId`
- `threadId`
- `roles`
- `participantLinks`
- `leadRoleId`

### 2.2 Mention 是调度命令，不是 UI 装饰

`@Role` 的本质是：

1. 生成一份 handoff envelope。
2. 把 envelope 投递到目标角色的 member run。
3. 允许目标角色在同一 team 语境里续跑自己的 loop。

### 2.3 角色上下文必须可复用

动态 probe 已经证明，同一个成员在同一个 team 里会被二次激活，而且不是新会话，而是回到原来的组态上下文。

所以要有稳定映射：

- `threadId + roleId -> runKey`

### 2.4 Team orchestration 只负责接力，不替成员决定内部工具策略

Lead role 或 handoff planner 决定：

- 先叫谁
- 后叫谁
- 什么时候停止

被点名的角色自己决定：

- 要不要叫 sub-agent
- 要不要用 browser
- 如何安排工具顺序

### 2.5 Worker 必须挂在角色下面

不要做成：

- `team -> browser`

而要做成：

- `team -> role runtime -> worker runtime -> browser bridge`

后面做 `Architect / Coder / PM / Finance / Daily Operator / Harness` 都要靠这条边界。

---

## 3. 顶层模块

建议分成 7 层。

### 3.1 `TeamThreadStore`

职责：

- 持久化 team thread 元数据
- 维护 `roles / participantLinks / teamId`
- 对外提供一致的 REST / gateway / runtime 读写面

```ts
interface TeamThreadStore {
  get(threadId: string): Promise<TeamThread | null>;
  list(): Promise<TeamThread[]>;
  create(input: CreateTeamThreadInput): Promise<TeamThread>;
  update(threadId: string, patch: UpdateTeamThreadInput): Promise<TeamThread>;
  delete(threadId: string): Promise<void>;
}
```

### 3.2 `TeamRouteMap`

职责：

- 维护外部用户到 team 的绑定
- 维护 legacy DM / external actor 映射
- 保证一个外部 actor 不被重复绑定到多个 team

```ts
interface TeamRouteMap {
  findByExternalActor(channelId: string, userId: string): Promise<TeamThread | null>;
  attachParticipants(threadId: string, links: ParticipantLink[]): Promise<void>;
  detachParticipants(threadId: string, links: ParticipantLink[]): Promise<void>;
}
```

### 3.3 `TeamEventBus`

职责：

- 向桌面端或 UI 广播瘦事件
- 向 API 客户端广播完整 thread 更新

建议显式保留两类事件：

- `team.roster.updated`
- `thread.updated`

### 3.4 `HandoffPlanner`

职责：

- 解析消息里的 `@mention`
- 校验 handoff 是否允许
- 负责串行 / 并行 / 混合模式的投递策略
- 做去重、防环、限次

这是最值得主动重做的一层。

### 3.5 `RoleRunCoordinator`

职责：

- 为每个 `threadId + roleId` 管理稳定的 member run
- 记录 inbox、iteration、status
- 支持 run reuse

### 3.6 `RoleRuntime`

职责：

- 驱动单个角色的 prompt、工具、worker
- 接收 handoff envelope
- 产生角色回复或 worker delegation

### 3.7 `RecoveryDirector`

职责：

- 做 team 级收敛
- 在角色失败时决定 retry / fallback / skip / abort
- 保障 lead role 始终保留兜底权

这是后续形成产品差异化的关键层。

---

## 4. 核心数据结构

### 4.1 `TeamThread`

```ts
type TeamThread = {
  threadId: string;
  teamId: string;
  teamName: string;
  leadRoleId: string;
  roles: RoleSlot[];
  participantLinks: ParticipantLink[];
  createdAt: number;
  updatedAt: number;
};
```

### 4.2 `RoleSlot`

```ts
type RoleSlot = {
  roleId: string;
  name: string;
  seat: "lead" | "member";
  avatar?: string;
  runtime: "local" | "remote";
  status?: "online" | "offline" | "busy";
  model?: {
    provider: string;
    name: string;
  };
  capabilities?: string[];
};
```

### 4.3 `ParticipantLink`

```ts
type ParticipantLink = {
  channelId: string;
  userId: string;
  chatId?: string;
  displayName?: string;
  dmThreadId?: string;
  enabled: boolean;
};
```

### 4.4 `RoleRunState`

```ts
type RoleRunState = {
  runKey: string;
  threadId: string;
  roleId: string;
  mode: "group";
  status: "idle" | "queued" | "running" | "waiting_worker" | "failed";
  iterationCount: number;
  maxIterations: number;
  inbox: HandoffEnvelope[];
  lastDequeuedTaskId?: string;
  lastUserTouchAt?: number;
  lastActiveAt: number;
};
```

### 4.5 `HandoffEnvelope`

```ts
type HandoffEnvelope = {
  taskId: string;
  flowId: string;
  sourceMessageId: string;
  sourceRoleId?: string;
  targetRoleId: string;
  activationType: "mention" | "cascade" | "retry" | "fallback";
  createdAt: number;
  payload: {
    threadId: string;
    relayBrief: string;
    recentMessages: TeamMessageSummary[];
    instructions?: string;
    policy: DispatchPolicy;
  };
};
```

### 4.6 `FlowLedger`

```ts
type FlowLedger = {
  flowId: string;
  threadId: string;
  rootMessageId: string;
  mode: "serial" | "parallel" | "mixed";
  status: "created" | "running" | "waiting_role" | "waiting_worker" | "completed" | "failed" | "aborted";
  activeRoleIds: string[];
  completedRoleIds: string[];
  failedRoleIds: string[];
  nextExpectedRoleId?: string;
  hopCount: number;
  maxHops: number;
  edges: HandoffEdge[];
  createdAt: number;
  updatedAt: number;
};
```

---

## 5. 状态机

### 5.1 Team flow state machine

```text
IDLE
  -> ACTIVATING_LEAD
  -> WAITING_ROLE
  -> ROLE_RUNNING
  -> HANDOFF_PENDING
  -> WAITING_NEXT_ROLE
  -> COMPLETED
  -> FAILED
```

关键点：

- `HANDOFF_PENDING` 必须是显式状态。
- handoff 不能只靠消息追加来隐式表达。

### 5.2 Member run state machine

```text
IDLE
  -> QUEUED
  -> RUNNING
  -> WAITING_WORKER
  -> RESUMING
  -> DONE
  -> FAILED
```

必须支持：

- 同一 run 多次 `QUEUED`
- `RUNNING -> QUEUED` 的重入
- `WAITING_WORKER -> RESUMING`

### 5.3 Handoff edge state machine

```text
CREATED
  -> DELIVERED
  -> ACKED
  -> RESPONDED
  -> CLOSED
  -> TIMEOUT
  -> CANCELLED
```

---

## 6. `HandoffPlanner` 的规则

### 6.1 显式区分 flow mode

```ts
type FlowMode =
  | { mode: "serial"; orderedRoleIds: string[] }
  | { mode: "parallel"; targetRoleIds: string[] }
  | { mode: "mixed"; stages: Array<{ type: "serial" | "parallel"; roleIds: string[] }> };
```

不要让 runtime 猜用户想要串行还是并行。

### 6.2 禁掉伪并行注入

如果 flow mode 是 `serial`：

1. 只允许一个 active role。
2. 不生成任何并行提示。
3. 不允许多个 inbox 同时被消费。

### 6.3 Anti-loop guard

至少保留四条规则：

1. 同一 `sourceMessageId + targetRoleId` 不重复投递。
2. 同一 flow 里，同一 role 的连续激活次数可配置。
3. 整个 flow 的 hop 上限可配置。
4. 出现回环时交给 `RecoveryDirector` 决策，而不是静默截断。

---

## 7. `CoordinationEngine` 与 `RoleRuntime` 的边界

### `CoordinationEngine` 负责

- team thread 元数据
- flow ledger
- handoff graph
- activation queue
- team 级失败策略
- 最终收敛

### `RoleRuntime` 负责

- prompt 组装
- 工具选择
- worker 委派
- 单角色内部 loop

### `BrowserWorker` 负责

- 具体网页交互
- page state
- screenshot / snapshot / act / console

这层分清以后，后面的角色只是在 `RoleRuntime` 层换配置，不需要改调度内核。

---

## 8. 失败处理策略

### 8.1 角色失败不等于整条 flow 失败

```ts
type RoleFailurePolicy =
  | "retry_same_model"
  | "retry_other_model"
  | "fallback_to_lead"
  | "skip_and_continue"
  | "abort_flow";
```

建议默认：

- `Daily / Architect / Product Manager` 失败：`fallback_to_lead`
- `browser worker` 失败：`retry_same_model` 或 `retry_other_tool`
- `Finance` 失败：`skip_and_continue`

### 8.2 限次要拆两层

```ts
type RuntimeLimits = {
  memberMaxIterations: 6;
  flowMaxHops: 20;
  maxQueuedHandoffsPerRole: 4;
};
```

不要只靠一个粗糙的 iteration cap。

### 8.3 lead role 必须保留兜底权

以下情况都应自动回交 lead：

- 被点名角色超时
- 模型 5xx / overload
- worker 失败
- handoff graph 出现环
- flow 到达 hop 上限

---

## 9. 最小接口草图

### 9.1 `CoordinationEngine`

```ts
interface CoordinationEngine {
  startFlow(input: StartFlowInput): Promise<FlowLedger>;
  handleUserPost(input: UserPostInput): Promise<void>;
  handleRoleReply(input: RoleReplyInput): Promise<void>;
  dispatchHandoff(input: DispatchHandoffInput): Promise<void>;
  completeFlow(flowId: string): Promise<void>;
  failFlow(flowId: string, reason: FlowFailureReason): Promise<void>;
}
```

### 9.2 `RoleRunCoordinator`

```ts
interface RoleRunCoordinator {
  getOrCreate(threadId: string, roleId: string): Promise<RoleRunState>;
  enqueue(runKey: string, handoff: HandoffEnvelope): Promise<void>;
  ack(runKey: string, taskId: string): Promise<void>;
  finish(runKey: string, result: RoleRunResult): Promise<void>;
  fail(runKey: string, error: RoleRunError): Promise<void>;
}
```

### 9.3 `HandoffPlanner`

```ts
interface HandoffPlanner {
  parseMentions(message: string): HandoffTarget[];
  validateDispatch(input: DispatchHandoffInput): Promise<DispatchDecision>;
  schedule(input: DispatchHandoffInput): Promise<DispatchReceipt[]>;
}
```

### 9.4 `RecoveryDirector`

```ts
interface RecoveryDirector {
  onRoleSuccess(input: RoleSuccessEvent): Promise<RecoveryDecision>;
  onRoleFailure(input: RoleFailureEvent): Promise<RecoveryDecision>;
  onFlowTimeout(input: FlowTimeoutEvent): Promise<RecoveryDecision>;
}
```

---

## 10. 持久化建议

至少落三类存储。

### 10.1 Team thread store

保存：

- `teamId`
- `roles`
- `participantLinks`
- `leadRoleId`

### 10.2 Member run store

保存：

- `runKey`
- `roleId`
- `threadId`
- `iterationCount`
- `inbox`
- `status`

### 10.3 Flow ledger store

保存：

- `flowId`
- `rootMessageId`
- `handoff graph`
- `active / failed / completed roles`
- `nextExpectedRoleId`
- `final status`

这层是后面做 QC、审计、回放、Harness 的基础。

---

## 11. 建议主动修掉的旧缺陷

不要原样照搬观测到的行为，建议主动修掉这 5 点：

1. 串行或并行必须由 flow plan 显式定义。
2. handoff edge 必须是一等对象，不能只靠消息回推。
3. 角色失败默认回交 lead，而不是直接断链。
4. iteration limit 分 role 层和 flow 层两套。
5. 每次 handoff 都记录 `why / expected output / next owner`。

---

## 12. 实现顺序

### Phase 1

- `TeamThreadStore`
- `RoleRunCoordinator`
- `HandoffPlanner`
- `RoleRuntime`

目标：

- 跑通 `Daily -> PM -> Finance -> Daily`

### Phase 2

- `WorkerRuntime`
- `BrowserBridge`
- `RoleRuntime -> WorkerRuntime`

目标：

- 跑通 `Daily -> Operator(browser) -> Daily`

### Phase 3

- 二次激活
- flow ledger
- `RecoveryDirector`
- lead fallback

目标：

- 跑通 `Daily -> PM -> Finance -> Browser -> PM -> Daily`

### Phase 4

- QC hooks
- replay
- harness integration

目标：

- 把 team runtime 升级为长期可审计、可回放、可压测的执行底座

---

## 13. 一句话总结

真正值得保留的不是“群聊里能叫浏览器干活”，而是：

- 角色可被重复唤起
- 角色可继续派生 worker
- team 和 worker 共享同一套 flow / run / recovery 结构

所以最合理的抽象是：

- `TeamThreadStore`
- `HandoffPlanner`
- `RoleRunCoordinator`
- `RoleRuntime`
- `WorkerRuntime`
- `RecoveryDirector`

这 6 层组成的一套可复用协作运行时。
