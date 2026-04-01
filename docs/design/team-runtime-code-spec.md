# 自研 Team Runtime 代码规格

> 更新日期：2026-03-27
> 目标：把 Team Runtime 设计草图细化成可直接编码的包结构、接口、状态模型、调度算法和持久化形态

---

## 1. 仓结构建议

```text
packages/
  core-types/
  team-store/
  team-runtime/
  role-runtime/
  worker-runtime/
  browser-bridge/
  qc-runtime/
  app-gateway/
```

### 1.1 `core-types`

职责：

- 共享类型
- event names
- message envelope
- runtime error codes

### 1.2 `team-store`

职责：

- `TeamThreadStore`
- `FlowLedgerStore`
- `RoleRunStore`
- 文件或数据库持久化

### 1.3 `team-runtime`

职责：

- `CoordinationEngine`
- `HandoffPlanner`
- `RecoveryDirector`
- `ExecutionCoordinator`

### 1.4 `role-runtime`

职责：

- 单角色运行时
- prompt 组装
- 工具与 worker 选择
- 角色内部的循环控制

### 1.5 `worker-runtime`

职责：

- 通用 worker 抽象
- `browser / coder / finance / explore / harness`

### 1.6 `browser-bridge`

职责：

- browser tool API
- relay / cdp / playwright action 层
- page state / ref store

### 1.7 `qc-runtime`

职责：

- 步骤验证
- 结果验证
- fallback policy
- execution replay hook

### 1.8 `app-gateway`

职责：

- websocket / REST
- 桌面端事件广播
- UI-facing payload 组装

---

## 2. 核心类型

### 2.1 Identity / Message

```ts
export type ThreadId = string;
export type TeamId = string;
export type RoleId = string;
export type FlowId = string;
export type RunKey = string;
export type MessageId = string;
export type TaskId = string;

export type TeamMessageRole = "user" | "assistant" | "tool" | "system";

export interface TeamMessage {
  id: MessageId;
  threadId: ThreadId;
  role: TeamMessageRole;
  roleId?: RoleId;
  name: string;
  content: string;
  createdAt: number;
  updatedAt: number;
  source?: MessageSource;
  metadata?: Record<string, unknown>;
}

export interface MessageSource {
  type: "desktop" | "api" | "worker";
  chatType: "group" | "dm";
  route:
    | "user"
    | "lead-role"
    | "external-participant"
    | "member-worker"
    | "worker";
  speakerType?: "User" | "Role" | "Tool";
  speakerName?: string;
}
```

### 2.2 Team thread

```ts
export interface TeamThread {
  threadId: ThreadId;
  teamId: TeamId;
  teamName: string;
  leadRoleId: RoleId;
  roles: RoleSlot[];
  participantLinks: ParticipantLink[];
  metadataVersion: number;
  createdAt: number;
  updatedAt: number;
}

export interface RoleSlot {
  roleId: RoleId;
  name: string;
  seat: "lead" | "member";
  avatar?: string;
  runtime: "local" | "remote";
  model?: ModelRef;
  status?: "online" | "offline" | "busy";
  capabilities?: string[];
}

export interface ModelRef {
  provider: string;
  name: string;
}

export interface ParticipantLink {
  channelId: string;
  userId: string;
  chatId?: string;
  displayName?: string;
  dmThreadId?: string;
  enabled: boolean;
}
```

### 2.3 Flow ledger

```ts
export interface FlowLedger {
  flowId: FlowId;
  threadId: ThreadId;
  rootMessageId: MessageId;
  mode: DispatchMode;
  status: FlowStatus;
  currentStageIndex: number;
  activeRoleIds: RoleId[];
  completedRoleIds: RoleId[];
  failedRoleIds: RoleId[];
  nextExpectedRoleId?: RoleId;
  hopCount: number;
  maxHops: number;
  edges: HandoffEdge[];
  createdAt: number;
  updatedAt: number;
}

export type DispatchMode = "serial" | "parallel" | "mixed";

export type FlowStatus =
  | "created"
  | "running"
  | "waiting_role"
  | "waiting_worker"
  | "completed"
  | "failed"
  | "aborted";

export interface HandoffEdge {
  edgeId: string;
  flowId: FlowId;
  fromRoleId?: RoleId;
  toRoleId: RoleId;
  sourceMessageId: MessageId;
  state: HandoffState;
  createdAt: number;
  respondedAt?: number;
  closedAt?: number;
}

export type HandoffState =
  | "created"
  | "delivered"
  | "acked"
  | "responded"
  | "closed"
  | "timeout"
  | "cancelled";
```

### 2.4 Member run / handoff inbox

```ts
export interface RoleRunState {
  runKey: RunKey;
  threadId: ThreadId;
  roleId: RoleId;
  mode: "group";
  status: RoleRunStatus;
  iterationCount: number;
  maxIterations: number;
  inbox: HandoffEnvelope[];
  lastDequeuedTaskId?: TaskId;
  lastActiveAt: number;
  lastUserTouchAt?: number;
}

export type RoleRunStatus =
  | "idle"
  | "queued"
  | "running"
  | "waiting_worker"
  | "resuming"
  | "done"
  | "failed";

export interface HandoffEnvelope {
  taskId: TaskId;
  flowId: FlowId;
  sourceMessageId: MessageId;
  sourceRoleId?: RoleId;
  targetRoleId: RoleId;
  activationType: "mention" | "cascade" | "retry" | "fallback";
  threadId: ThreadId;
  payload: RelayPayload;
  createdAt: number;
}

export interface RelayPayload {
  threadId: ThreadId;
  relayBrief: string;
  recentMessages: TeamMessageSummary[];
  instructions?: string;
  dispatchPolicy: DispatchPolicy;
}

export interface TeamMessageSummary {
  messageId: MessageId;
  role: TeamMessageRole;
  roleId?: RoleId;
  name: string;
  content: string;
  createdAt: number;
}

export interface DispatchPolicy {
  allowParallel: boolean;
  allowReenter: boolean;
  expectedNextRoleIds?: RoleId[];
  sourceFlowMode: DispatchMode;
}
```

### 2.5 Runtime errors

```ts
export type RuntimeErrorCode =
  | "MODEL_OVERLOADED"
  | "MODEL_5XX"
  | "WORKER_TIMEOUT"
  | "WORKER_FAILED"
  | "HANDOFF_LOOP"
  | "RUN_ITERATION_LIMIT"
  | "FLOW_HOP_LIMIT"
  | "INVALID_MENTION"
  | "ROLE_MISSING"
  | "TEAM_POLICY_VIOLATION";

export interface RuntimeError {
  code: RuntimeErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}
```

---

## 3. REST / Gateway Envelope

### 3.1 Team thread REST

```ts
export interface CreateTeamThreadInput {
  teamName: string;
  leadRoleId: RoleId;
  roles: RoleSlot[];
  participantLinks?: ParticipantLink[];
}

export interface UpdateTeamThreadInput {
  teamName?: string;
  roles?: RoleSlot[];
  participantLinks?: ParticipantLink[];
}
```

### 3.2 WebSocket events

```ts
export type TeamGatewayEvent =
  | { type: "team.roster.updated"; data: TeamRosterUpdatedEvent }
  | { type: "thread.updated"; data: TeamThread }
  | { type: "team.flow.updated"; data: FlowLedger }
  | { type: "team.run.updated"; data: RoleRunState };

export interface TeamRosterUpdatedEvent {
  threadId: ThreadId;
  teamId: TeamId;
  teamName: string;
  roles: Array<Pick<RoleSlot, "roleId" | "name" | "seat" | "avatar">>;
  participantLinks: ParticipantLink[];
  addedParticipantLinks?: ParticipantLink[];
  removedParticipantLinks?: ParticipantLink[];
  action: "sync";
}
```

### 3.3 Message API

```ts
export interface SendTeamMessageInput {
  threadId: ThreadId;
  content: string;
  userId?: string;
  metadata?: Record<string, unknown>;
}
```

---

## 4. Service contracts

### 4.1 `TeamThreadStore`

```ts
export interface TeamThreadStore {
  get(threadId: ThreadId): Promise<TeamThread | null>;
  list(): Promise<TeamThread[]>;
  create(input: CreateTeamThreadInput): Promise<TeamThread>;
  update(threadId: ThreadId, patch: UpdateTeamThreadInput): Promise<TeamThread>;
  delete(threadId: ThreadId): Promise<void>;
}
```

### 4.2 `TeamMessageStore`

```ts
export interface TeamMessageStore {
  append(message: TeamMessage): Promise<void>;
  list(threadId: ThreadId, limit?: number): Promise<TeamMessage[]>;
  get(messageId: MessageId): Promise<TeamMessage | null>;
}
```

### 4.3 `RoleRunStore`

```ts
export interface RoleRunStore {
  get(runKey: RunKey): Promise<RoleRunState | null>;
  put(runState: RoleRunState): Promise<void>;
  delete(runKey: RunKey): Promise<void>;
  listByThread(threadId: ThreadId): Promise<RoleRunState[]>;
}
```

### 4.4 `FlowLedgerStore`

```ts
export interface FlowLedgerStore {
  get(flowId: FlowId): Promise<FlowLedger | null>;
  put(flow: FlowLedger): Promise<void>;
  listByThread(threadId: ThreadId): Promise<FlowLedger[]>;
}
```

### 4.5 `TeamRouteMap`

```ts
export interface TeamRouteMap {
  findByExternalActor(channelId: string, userId: string): Promise<TeamThread | null>;
  assertParticipantUniqueness(bindings: ParticipantLink[]): Promise<void>;
  attachParticipants(threadId: ThreadId, bindings: ParticipantLink[]): Promise<void>;
  detachParticipants(threadId: ThreadId, bindings: ParticipantLink[]): Promise<void>;
}
```

### 4.6 `RoleRunCoordinator`

```ts
export interface RoleRunCoordinator {
  getOrCreate(threadId: ThreadId, roleId: RoleId): Promise<RoleRunState>;
  enqueue(runKey: RunKey, handoff: HandoffEnvelope): Promise<RoleRunState>;
  dequeue(runKey: RunKey): Promise<HandoffEnvelope | null>;
  ack(runKey: RunKey, taskId: TaskId): Promise<void>;
  setStatus(runKey: RunKey, status: RoleRunStatus): Promise<void>;
  incrementIteration(runKey: RunKey): Promise<number>;
  fail(runKey: RunKey, error: RuntimeError): Promise<void>;
  finish(runKey: RunKey): Promise<void>;
}
```

### 4.7 `HandoffPlanner`

```ts
export interface HandoffPlanner {
  parseMentions(content: string): HandoffTarget[];
  validateMentionTargets(thread: TeamThread, input: ValidateMentionInput): Promise<DispatchDecision>;
  buildHandoffs(input: BuildHandoffsInput): Promise<HandoffEnvelope[]>;
}

export interface HandoffTarget {
  raw: string;
  roleId: RoleId;
  offsetStart: number;
  offsetEnd: number;
}

export interface ValidateMentionInput {
  flow: FlowLedger;
  sourceRoleId?: RoleId;
  messageId: MessageId;
  content: string;
}

export interface DispatchDecision {
  allowed: boolean;
  reason?: string;
  mode: DispatchMode;
  targetRoleIds: RoleId[];
}
```

### 4.8 `RoleRuntime`

```ts
export interface RoleRuntime {
  runActivation(input: RoleActivationInput): Promise<RoleRuntimeResult>;
}

export interface RoleActivationInput {
  runState: RoleRunState;
  thread: TeamThread;
  flow: FlowLedger;
  handoff: HandoffEnvelope;
}

export interface RoleRuntimeResult {
  status: "ok" | "failed" | "delegated";
  message?: TeamMessage;
  mentions?: RoleId[];
  spawnedWorkers?: SpawnedWorker[];
  error?: RuntimeError;
}

export interface SpawnedWorker {
  workerType: "browser" | "coder" | "finance" | "explore" | "harness";
  workerRunKey: RunKey;
}
```

### 4.9 `RecoveryDirector`

```ts
export interface RecoveryDirector {
  onUserMessage(input: SupervisorUserMessageInput): Promise<RecoveryDecision>;
  onRoleReply(input: SupervisorRoleReplyInput): Promise<RecoveryDecision>;
  onRoleFailure(input: SupervisorRoleFailureInput): Promise<RecoveryDecision>;
}

export type RecoveryDecision =
  | { action: "dispatch"; targetRoleIds: RoleId[] }
  | { action: "retry"; targetRoleId: RoleId; strategy: RetryStrategy }
  | { action: "fallback_to_lead"; leadRoleId: RoleId }
  | { action: "complete" }
  | { action: "abort"; reason: string };

export type RetryStrategy = "same_model" | "other_model" | "same_worker" | "other_worker";
```

---

## 5. 关键算法

### 5.1 `handleUserPost()`

职责：

- 落 user message
- 新建 flow ledger
- 让 lead role 接第一棒

```ts
export async function handleUserPost(input: SendTeamMessageInput): Promise<void> {
  const thread = await teamThreadStore.get(input.threadId);
  if (!thread) throw new Error("team thread not found");

  const userMessage: TeamMessage = {
    id: idGen.message(),
    threadId: thread.threadId,
    role: "user",
    name: "user",
    content: input.content,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    source: {
      type: "desktop",
      chatType: "group",
      route: "user",
      speakerType: "User",
      speakerName: "user",
    },
  };

  await teamMessageStore.append(userMessage);

  const flow: FlowLedger = {
    flowId: idGen.flow(),
    threadId: thread.threadId,
    rootMessageId: userMessage.id,
    mode: "serial",
    status: "created",
    currentStageIndex: 0,
    activeRoleIds: [],
    completedRoleIds: [],
    failedRoleIds: [],
    nextExpectedRoleId: thread.leadRoleId,
    hopCount: 0,
    maxHops: runtimeLimits.flowMaxHops,
    edges: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  await flowLedgerStore.put(flow);
  await coordinationEngine.dispatchToLead(thread, flow, userMessage);
}
```

### 5.2 `dispatchToRole()`

```ts
export async function dispatchToRole(input: {
  thread: TeamThread;
  flow: FlowLedger;
  sourceMessage: TeamMessage;
  fromRoleId?: RoleId;
  toRoleId: RoleId;
  activationType: HandoffEnvelope["activationType"];
  instructions?: string;
}): Promise<void> {
  const runState = await roleRunCoordinator.getOrCreate(input.thread.threadId, input.toRoleId);

  const handoff: HandoffEnvelope = {
    taskId: idGen.task(),
    flowId: input.flow.flowId,
    sourceMessageId: input.sourceMessage.id,
    sourceRoleId: input.fromRoleId,
    targetRoleId: input.toRoleId,
    activationType: input.activationType,
    threadId: input.thread.threadId,
    payload: {
      threadId: input.thread.threadId,
      relayBrief: relayBriefBuilder.build({
        thread: input.thread,
        sourceMessage: input.sourceMessage,
        targetRoleId: input.toRoleId,
        instructions: input.instructions,
      }),
      recentMessages: await summaryBuilder.getRecentMessages(input.thread.threadId),
      instructions: input.instructions,
      dispatchPolicy: {
        allowParallel: input.flow.mode !== "serial",
        allowReenter: true,
        expectedNextRoleIds: input.flow.nextExpectedRoleId ? [input.flow.nextExpectedRoleId] : undefined,
        sourceFlowMode: input.flow.mode,
      },
    },
    createdAt: Date.now(),
  };

  await roleRunCoordinator.enqueue(runState.runKey, handoff);
  await executionCoordinator.markHandoffCreated(input.flow.flowId, handoff);
  await roleLoopRunner.ensureRunning(runState.runKey);
}
```

### 5.3 `drainRoleRun()`

这是核心循环。

```ts
export async function drainRoleRun(runKey: RunKey): Promise<void> {
  const runState = await roleRunStore.get(runKey);
  if (!runState) return;

  if (runState.status === "running") return;
  await roleRunCoordinator.setStatus(runKey, "running");

  while (true) {
    const current = await roleRunStore.get(runKey);
    if (!current) return;

    if (current.iterationCount >= current.maxIterations) {
      await roleRunCoordinator.fail(runKey, {
        code: "RUN_ITERATION_LIMIT",
        message: "member run iteration limit reached",
        retryable: false,
      });
      return;
    }

    const handoff = await roleRunCoordinator.dequeue(runKey);
    if (!handoff) {
      await roleRunCoordinator.setStatus(runKey, "idle");
      return;
    }

    await roleRunCoordinator.incrementIteration(runKey);
    await roleRunCoordinator.ack(runKey, handoff.taskId);

    const flow = await flowLedgerStore.get(handoff.flowId);
    const thread = await teamThreadStore.get(handoff.threadId);
    if (!flow || !thread) continue;

    const result = await roleRuntime.runActivation({
      runState: current,
      thread,
      flow,
      handoff,
    });

    if (result.status === "ok" && result.message) {
      await teamMessageStore.append(result.message);
      await executionCoordinator.onRoleReply({
        flow,
        thread,
        runState: current,
        message: result.message,
        mentions: result.mentions ?? [],
      });
      continue;
    }

    if (result.status === "delegated") {
      await roleRunCoordinator.setStatus(runKey, "waiting_worker");
      continue;
    }

    await executionCoordinator.onRoleFailure({
      flow,
      thread,
      runState: current,
      handoff,
      error: result.error ?? {
        code: "WORKER_FAILED",
        message: "unknown role failure",
        retryable: false,
      },
    });
  }
}
```

### 5.4 `handleRoleReply()`

```ts
export async function handleRoleReply(input: {
  flow: FlowLedger;
  thread: TeamThread;
  runState: RoleRunState;
  message: TeamMessage;
  mentions: RoleId[];
}): Promise<void> {
  const parsedMentions = handoffPlanner.parseMentions(input.message.content);

  const decision = await handoffPlanner.validateMentionTargets(input.thread, {
    flow: input.flow,
    sourceRoleId: input.runState.roleId,
    messageId: input.message.id,
    content: input.message.content,
  });

  await executionCoordinator.markRoleCompleted(input.flow.flowId, input.runState.roleId);

  if (!decision.allowed || decision.targetRoleIds.length === 0) {
    const recovery = await recoveryDirector.onRoleReply({
      thread: input.thread,
      flow: input.flow,
      message: input.message,
      mentions: parsedMentions.map((item) => item.roleId),
    });

    await executionCoordinator.applyRecoveryDecision(recovery, input.flow, input.thread, input.message);
    return;
  }

  for (const targetRoleId of decision.targetRoleIds) {
    await dispatchToRole({
      thread: input.thread,
      flow: input.flow,
      sourceMessage: input.message,
      fromRoleId: input.runState.roleId,
      toRoleId: targetRoleId,
      activationType: "mention",
    });
  }
}
```

### 5.5 `onRoleFailure()`

```ts
export async function onRoleFailure(input: {
  flow: FlowLedger;
  thread: TeamThread;
  runState: RoleRunState;
  handoff: HandoffEnvelope;
  error: RuntimeError;
}): Promise<void> {
  await executionCoordinator.markRoleFailed(input.flow.flowId, input.runState.roleId, input.error);

  const recovery = await recoveryDirector.onRoleFailure({
    flow: input.flow,
    thread: input.thread,
    failedRoleId: input.runState.roleId,
    error: input.error,
  });

  await executionCoordinator.applyRecoveryDecision(
    recovery,
    input.flow,
    input.thread,
    await systemMessageFactory.fromFailure(input.thread.threadId, input.runState.roleId, input.error)
  );
}
```

---

## 6. Mention 解析和防环

### 6.1 Parser

```ts
const MENTION_RE = /@\\{(?<roleId>[^}]+)\\}/g;

export function parseMentions(content: string): HandoffTarget[] {
  const out: HandoffTarget[] = [];
  for (const match of content.matchAll(MENTION_RE)) {
    const roleId = match.groups?.roleId;
    if (!roleId || match.index == null) continue;

    out.push({
      raw: match[0],
      roleId,
      offsetStart: match.index,
      offsetEnd: match.index + match[0].length,
    });
  }
  return out;
}
```

### 6.2 Dedupe key

```ts
export function buildHandoffDedupeKey(input: {
  flowId: FlowId;
  sourceMessageId: MessageId;
  targetRoleId: RoleId;
}): string {
  return `${input.flowId}:${input.sourceMessageId}:${input.targetRoleId}`;
}
```

### 6.3 Loop guard

```ts
export interface LoopGuard {
  seenHandoffs: Set<string>;
  perRoleHopCount: Map<RoleId, number>;
  chain: Array<{ from?: RoleId; to: RoleId; messageId: MessageId }>;
}

export function assertLoopSafe(input: {
  guard: LoopGuard;
  dedupeKey: string;
  targetRoleId: RoleId;
  maxPerRoleHopCount: number;
}): void {
  if (input.guard.seenHandoffs.has(input.dedupeKey)) {
    throw new Error("duplicate handoff");
  }

  const hopCount = input.guard.perRoleHopCount.get(input.targetRoleId) ?? 0;
  if (hopCount >= input.maxPerRoleHopCount) {
    throw new Error("per-role hop limit exceeded");
  }
}
```

---

## 7. `relayBrief` 生成规则

这块不要做成不可控字符串拼接，应该是 deterministic builder。

```ts
export interface RelayBriefBuilder {
  build(input: {
    thread: TeamThread;
    sourceMessage: TeamMessage;
    targetRoleId: RoleId;
    instructions?: string;
    includeRecentMessages?: number;
  }): string;
}
```

建议输出结构：

```text
<relay_brief>
Flow ID: FLOW-...
Thread: thread-...
Dispatch Mode: serial
Current Target: Product Manager
Expected Next: Financial Expert

Recent team messages:
[User]: ...
[Daily Assistant]: ...

You were mentioned in the team thread.
Task for you:
1. ...
2. ...
3. ...

Rules:
- Do not answer for other members.
- Only mention the next role when you are explicitly handing off.
- If you fail, explain the failure briefly instead of going silent.
</relay_brief>
```

不要：

- 自动生成并行提示
- 自动猜角色顺序

---

## 8. `RecoveryDirector` 决策表

### 8.1 默认策略

```ts
export const DEFAULT_FAILURE_POLICY: Record<string, RoleFailurePolicy> = {
  "daily-assistant": "fallback_to_lead",
  "product-manager": "fallback_to_lead",
  finance: "skip_and_continue",
  browser: "retry_other_model",
  coder: "retry_same_model",
};
```

### 8.2 决策逻辑

```ts
export async function onRoleFailure(input: SupervisorRoleFailureInput): Promise<RecoveryDecision> {
  if (input.error.code === "MODEL_OVERLOADED" || input.error.code === "MODEL_5XX") {
    if (input.failedRoleId === input.thread.leadRoleId) {
      return { action: "abort", reason: "lead role failed and no fallback exists" };
    }
    return { action: "fallback_to_lead", leadRoleId: input.thread.leadRoleId };
  }

  if (input.error.code === "WORKER_TIMEOUT" || input.error.code === "WORKER_FAILED") {
    return { action: "retry", targetRoleId: input.failedRoleId, strategy: "same_worker" };
  }

  if (input.error.code === "RUN_ITERATION_LIMIT" || input.error.code === "HANDOFF_LOOP") {
    return { action: "fallback_to_lead", leadRoleId: input.thread.leadRoleId };
  }

  return { action: "abort", reason: input.error.message };
}
```

---

## 9. `RoleRuntime` 和 `WorkerRuntime` 接缝

### 9.1 Worker 抽象

```ts
export interface WorkerRuntime {
  spawn(input: SpawnWorkerInput): Promise<SpawnWorkerResult>;
  send(input: SendWorkerMessageInput): Promise<SendWorkerMessageResult>;
  getState(runKey: RunKey): Promise<WorkerSessionState | null>;
}

export interface SpawnWorkerInput {
  parentRunKey: RunKey;
  parentRoleId: RoleId;
  workerType: "browser" | "coder" | "finance" | "explore" | "harness";
  task: string;
  workspaceDir?: string;
}
```

### 9.2 Role policy 层

```ts
export interface RoleExecutionPolicy {
  maxToolCalls: number;
  allowWorkers: boolean;
  allowedWorkerTypes: Array<SpawnWorkerInput["workerType"]>;
  allowedTools: string[];
}

export const DAILY_POLICY: RoleExecutionPolicy = {
  maxToolCalls: 12,
  allowWorkers: true,
  allowedWorkerTypes: ["browser", "coder", "finance", "explore"],
  allowedTools: ["read", "write", "web_search", "spawn_worker"],
};
```

---

## 10. 持久化文件形态建议

### 10.1 team thread

```json
{
  "threadId": "CID-...",
  "teamId": "team-CID-...",
  "teamName": "Growth Team",
  "leadRoleId": "MID-lead",
  "roles": [
    { "roleId": "MID-lead", "name": "Daily Assistant", "seat": "lead", "runtime": "local" },
    { "roleId": "MID-pm", "name": "Product Manager", "seat": "member", "runtime": "local" }
  ],
  "participantLinks": [],
  "metadataVersion": 1,
  "createdAt": 1774600000000,
  "updatedAt": 1774600000000
}
```

### 10.2 member run

```json
{
  "runKey": "role:MID-pm:thread:CID-...",
  "threadId": "CID-...",
  "roleId": "MID-pm",
  "mode": "group",
  "status": "idle",
  "iterationCount": 0,
  "maxIterations": 6,
  "inbox": [],
  "lastActiveAt": 1774600000000
}
```

### 10.3 flow ledger

```json
{
  "flowId": "FLOW-...",
  "threadId": "CID-...",
  "rootMessageId": "MSG-root",
  "mode": "serial",
  "status": "running",
  "currentStageIndex": 2,
  "activeRoleIds": ["MID-browser-owner"],
  "completedRoleIds": ["MID-lead", "MID-pm", "MID-finance"],
  "failedRoleIds": [],
  "nextExpectedRoleId": "MID-pm",
  "hopCount": 4,
  "maxHops": 20,
  "edges": []
}
```

---

## 11. Browser worker 接入点

browser bridge 的细节建议单独维护在 browser session / worker protocol 设计文档中，不要和 team runtime 规格混在一起。

在 Team Runtime 里只需要把 browser 当成一种 worker：

```ts
export async function maybeSpawnBrowserWorker(input: {
  rolePolicy: RoleExecutionPolicy;
  runState: RoleRunState;
  task: string;
}): Promise<SpawnedWorker | null> {
  if (!input.rolePolicy.allowWorkers) return null;
  if (!input.rolePolicy.allowedWorkerTypes.includes("browser")) return null;
  if (!shouldUseBrowser(input.task)) return null;

  const result = await workerRuntime.spawn({
    parentRunKey: input.runState.runKey,
    parentRoleId: input.runState.roleId,
    workerType: "browser",
    task: input.task,
  });

  return {
    workerType: "browser",
    workerRunKey: result.runKey,
  };
}
```

核心原则：

- `team -> member run -> worker run`

不要做成：

- `team -> browser run`

---

## 12. 优先落代码的文件

如果开始实现，建议先写这 5 个文件：

```text
packages/core-types/src/team.ts
packages/team-store/src/file-team-thread-store.ts
packages/team-runtime/src/handoff-planner.ts
packages/team-runtime/src/role-run-coordinator.ts
packages/team-runtime/src/coordination-engine.ts
```

Phase 1 只做到：

1. 创建 team thread
2. 用户发消息
3. lead role 被激活
4. lead `@` 下一个角色
5. 下一个角色复用已有 member run 接棒
6. 失败自动 fallback 到 lead

这 6 步跑通以后，再接 `worker-runtime` 和 `browser-bridge`。

---

## 13. 落地建议

你真正要写的不是“支持 @mention 的聊天系统”，而是：

- 一套有 `flow ledger`
- 有 `member run reuse`
- 有 `worker delegation`
- 有 `failure supervision`

的协作执行操作系统。
