# Browser Session / Worker Protocol 设计

> 更新日期：2026-03-28
> 目的：定义长会话浏览器系统与统一 worker/subagent 协议，作为后续实现的主规格

---

## 1. 目标

这套设计要同时解决：

1. browser worker 不是一次性任务，而是可续跑 session
2. 登录态和 profile 可以复用
3. browser action trace 可审计
4. role 与 worker 之间有稳定协议
5. worker 能继续、能中断、能恢复

---

## 2. 核心原则

### 2.1 Role 不直接控制 browser internals

正确边界应为：

`role runtime -> worker runtime -> browser session runtime -> transport adapter`

### 2.2 Browser session 是一等对象

不要把每次 browser task 都当成无状态函数调用。

需要显式对象：

1. session
2. target/tab
3. profile
4. action trace
5. artifact set

### 2.3 transport 只是下层实现

浏览器系统上层不应依赖某一种 transport。

应支持：

1. extension relay
2. direct CDP
3. local automation adapter

### 2.4 worker 执行前要先做 capability discovery

worker 不应该盲目尝试执行。

更稳定的顺序应为：

1. 发现有哪些工具面存在
2. 检查哪些 connector 已授权
3. 检查哪些 API / skill 已配置
4. 根据 readiness 选择 transport 和 worker

也就是说，worker runtime 需要一个显式的 capability discovery 层，而不是把这些判断散落在 prompt 里。

### 2.5 transport hierarchy 必须显式建模

对于同一目标，系统可能有多种执行面：

1. official API
2. business tool / remote tool
3. browser automation

worker 选择策略不应只回答“有没有 browser capability”，还要回答：

1. 有没有更稳定的官方写入接口
2. 当前接口是否已授权
3. 当前接口是否已配置
4. 失败后下一层 fallback 是什么

---

## 3. Worker Protocol

建议把 worker 协议固定成下面 6 个动作：

```ts
interface WorkerRuntime {
  spawn(input: WorkerSpawnInput): Promise<SpawnedWorker | null>;
  send(input: WorkerMessageInput): Promise<WorkerExecutionResult | null>;
  getState(workerRunKey: string): Promise<WorkerSessionState | null>;
  resume(input: WorkerResumeInput): Promise<WorkerExecutionResult | null>;
  interrupt(input: WorkerInterruptInput): Promise<void>;
  cancel(input: WorkerCancelInput): Promise<void>;
}
```

配套建议增加：

```ts
interface CapabilityDiscoveryService {
  inspect(input: CapabilityInspectionInput): Promise<CapabilityInspectionResult>;
}
```

### 3.1 `spawn`

职责：

1. 创建 worker session
2. 分配 worker run key
3. 初始化生命周期状态

### 3.2 `send`

职责：

1. 向现有 worker session 发送任务
2. 允许 follow-up
3. 返回本轮执行结果

### 3.3 `resume`

职责：

1. 在 worker 中断或等待时恢复执行
2. 支持热恢复
3. 未来可扩展到冷恢复

### 3.4 `interrupt`

职责：

1. 请求 worker 停止继续调用工具
2. 尝试进入 evidence-only summarization

### 3.5 `cancel`

职责：

1. 终止 worker session
2. 释放占用资源
3. 写入终态

### 3.6 详细接口定义

```ts
type WorkerKind = "browser" | "coder" | "finance" | "explore" | "harness";

type WorkerSessionStatus =
  | "created"
  | "idle"
  | "running"
  | "waiting_input"
  | "waiting_external"
  | "resumable"
  | "done"
  | "failed"
  | "cancelled";

type WorkerOwnership = {
  threadId: string;
  parentRoleId: string;
  parentRunKey: string;
  parentFlowId: string;
};

interface WorkerSpawnInput {
  workerKind: WorkerKind;
  ownership: WorkerOwnership;
  taskId: string;
  title?: string;
  instructions: string;
  packet: WorkerPromptPacket;
  requestedCapabilities?: string[];
  preferredModel?: {
    provider: string;
    name: string;
  };
  sessionHints?: {
    reusable?: boolean;
    browserProfileScope?: "user" | "thread" | "role";
    browserSessionId?: string;
  };
}

interface WorkerMessageInput {
  workerRunKey: string;
  messageId: string;
  instructions: string;
  packet?: WorkerPromptPacket;
  artifactIds?: string[];
}

interface WorkerResumeInput {
  workerRunKey: string;
  reason: "follow_up" | "timeout_summary" | "user_resume" | "supervisor_retry";
  instructions?: string;
}

interface WorkerInterruptInput {
  workerRunKey: string;
  mode: "graceful" | "summarize_then_stop";
  reason: string;
}

interface WorkerCancelInput {
  workerRunKey: string;
  reason: string;
}

interface WorkerPromptPacket {
  systemPrompt: string;
  taskPrompt: string;
  outputContract: string;
  evidencePolicy: "minimal" | "standard" | "verbose";
  allowedTools?: string[];
}

interface WorkerExecutionResult {
  workerRunKey: string;
  workerType: WorkerKind;
  status: "completed" | "partial" | "failed";
  summary: string;
  payload: Record<string, unknown>;
  emittedArtifacts?: string[];
  traceDigest?: WorkerTraceDigest;
  error?: RuntimeError;
}

type CapabilityInspectionInput = {
  threadId: string;
  roleId: string;
  requestedCapabilities: string[];
  preferredWorkerKinds?: WorkerKind[];
};

type CapabilityInspectionResult = {
  availableWorkers: WorkerKind[];
  connectorStates: ConnectorCapabilityState[];
  apiStates: ApiCapabilityState[];
  skillStates: SkillCapabilityState[];
  transportPreferences: TransportPreference[];
};

type ConnectorCapabilityState = {
  provider: string;
  available: boolean;
  authorized: boolean;
};

type ApiCapabilityState = {
  name: string;
  configured: boolean;
};

type SkillCapabilityState = {
  skillId: string;
  installed: boolean;
};

type TransportPreference = {
  capability: string;
  orderedTransports: ("official_api" | "business_tool" | "browser")[];
};

interface WorkerTraceDigest {
  startedAt: number;
  completedAt?: number;
  totalSteps: number;
  toolChain: string[];
  lastMeaningfulStep?: string;
}
```

### 3.7 Worker 状态机

```text
created -> idle -> running -> waiting_input -> resumable -> running -> done
created -> idle -> running -> waiting_external -> resumable -> running -> done
running -> failed
running -> cancelled
waiting_input -> cancelled
resumable -> cancelled
```

约束：

1. 只有 `running / waiting_input / waiting_external / resumable` 能被 `interrupt`
2. 只有 `waiting_input / waiting_external / resumable` 能被 `resume`
3. `done / failed / cancelled` 为终态

---

## 4. Worker Session State

```ts
type WorkerSessionState = {
  workerRunKey: string;
  workerType: "browser" | "coder" | "finance" | "explore" | "harness";
  status: "idle" | "running" | "waiting" | "resumable" | "done" | "failed" | "cancelled";
  parentRunKey: string;
  parentRoleId: string;
  threadId: string;
  createdAt: number;
  updatedAt: number;
  currentTaskId?: string;
  lastResultDigest?: WorkerResultDigest;
  lastError?: RuntimeError;
  artifactIds?: string[];
};
```

### 4.1 Worker Session Store

```ts
interface WorkerSessionStore {
  get(workerRunKey: string): Promise<WorkerSessionState | null>;
  put(state: WorkerSessionState): Promise<void>;
  listByParentRun(parentRunKey: string): Promise<WorkerSessionState[]>;
  listByThread(threadId: string): Promise<WorkerSessionState[]>;
}

interface WorkerMessageStore {
  append(entry: WorkerMessageRecord): Promise<void>;
  list(workerRunKey: string, limit?: number): Promise<WorkerMessageRecord[]>;
}

type WorkerMessageRecord = {
  id: string;
  workerRunKey: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  createdAt: number;
  metadata?: Record<string, unknown>;
};
```

### 4.2 Scheduled Re-entry

除即时 worker session 外，还需要支持未来回流的 task capsule。

```ts
interface ScheduledTaskStore {
  get(taskId: string): Promise<ScheduledTaskRecord | null>;
  put(task: ScheduledTaskRecord): Promise<void>;
  listByThread(threadId: string): Promise<ScheduledTaskRecord[]>;
}

type ScheduledTaskRecord = {
  taskId: string;
  threadId: string;
  targetWorker?: WorkerKind;
  targetRoleId: string;
  sessionTarget: "main" | "worker";
  schedule: {
    kind: "cron";
    expr: string;
    tz: string;
    nextRunAt: number;
  };
  capsule: ScheduledPromptCapsule;
  createdAt: number;
  updatedAt: number;
};

type ScheduledPromptCapsule = {
  title: string;
  instructions: string;
  artifactRefs?: string[];
  dependencyRefs?: string[];
  expectedOutput?: string;
};
```

设计要求：

1. 定时任务必须绑定 thread
2. 定时任务必须能绑定 target role 或 target worker
3. capsule 必须可在未来独立执行，不依赖当前完整上下文窗口

---

## 5. Browser Session Model

### 5.1 `BrowserSession`

```ts
type BrowserSession = {
  browserSessionId: string;
  ownerType: "user" | "thread" | "role" | "worker";
  ownerId: string;
  profileId: string;
  transportMode: "relay" | "direct-cdp" | "local";
  status: "starting" | "ready" | "busy" | "disconnected" | "closed";
  createdAt: number;
  updatedAt: number;
  lastActiveAt: number;
  activeTargetId?: string;
  targetIds: string[];
};
```

### 5.2 `BrowserTarget`

```ts
type BrowserTarget = {
  targetId: string;
  browserSessionId: string;
  transportSessionId?: string;
  url: string;
  title?: string;
  status: "open" | "attached" | "detached" | "closed";
  createdAt: number;
  updatedAt: number;
};
```

### 5.3 `BrowserProfile`

```ts
type BrowserProfile = {
  profileId: string;
  scope: "user" | "thread" | "role";
  scopeId: string;
  persistentDir: string;
  loginState: "unknown" | "authenticated" | "anonymous";
  createdAt: number;
  updatedAt: number;
};
```

### 5.4 Browser Session Store

```ts
interface BrowserSessionStore {
  get(browserSessionId: string): Promise<BrowserSession | null>;
  put(session: BrowserSession): Promise<void>;
  listByOwner(ownerType: BrowserSession["ownerType"], ownerId: string): Promise<BrowserSession[]>;
  listActiveByProfile(profileId: string): Promise<BrowserSession[]>;
}

interface BrowserTargetStore {
  get(targetId: string): Promise<BrowserTarget | null>;
  put(target: BrowserTarget): Promise<void>;
  listBySession(browserSessionId: string): Promise<BrowserTarget[]>;
}

interface BrowserProfileStore {
  get(profileId: string): Promise<BrowserProfile | null>;
  put(profile: BrowserProfile): Promise<void>;
  findByScope(scope: BrowserProfile["scope"], scopeId: string): Promise<BrowserProfile | null>;
}
```

### 5.5 Browser Session Manager

```ts
interface BrowserSessionManager {
  acquireSession(input: BrowserSessionAcquireInput): Promise<BrowserSessionLease>;
  resumeSession(browserSessionId: string): Promise<BrowserSessionLease>;
  releaseSession(browserSessionId: string): Promise<void>;
  closeSession(browserSessionId: string, reason: string): Promise<void>;
  listTargets(browserSessionId: string): Promise<BrowserTarget[]>;
  ensureTarget(input: EnsureBrowserTargetInput): Promise<BrowserTarget>;
}

interface BrowserSessionAcquireInput {
  ownerType: BrowserSession["ownerType"];
  ownerId: string;
  profileScope: BrowserProfile["scope"];
  profileScopeId: string;
  preferredTransport?: BrowserSession["transportMode"];
  reusable: boolean;
}

interface EnsureBrowserTargetInput {
  browserSessionId: string;
  url?: string;
  targetId?: string;
  createIfMissing?: boolean;
}

interface BrowserSessionLease {
  session: BrowserSession;
  profile: BrowserProfile;
}
```

---

## 6. Browser Action Model

建议 browser action 继续保留结构化 schema，但补齐 resume / artifact / ref 语义。

```ts
type BrowserTaskRequest = {
  taskId: string;
  browserSessionId?: string;
  targetId?: string;
  instructions: string;
  actions: BrowserAction[];
  stopCondition?: string;
  evidencePolicy?: "minimal" | "standard" | "verbose";
};
```

### 6.2 Browser Action 详细类型

```ts
type BrowserAction =
  | { kind: "open"; url: string; waitUntil?: "domcontentloaded" | "load" | "networkidle" }
  | { kind: "snapshot"; note?: string; includeInteractives?: boolean }
  | { kind: "click"; refId?: string; selectors?: string[]; text?: string }
  | { kind: "type"; refId?: string; selectors?: string[]; text: string; submit?: boolean }
  | { kind: "wait"; timeMs?: number; text?: string; selector?: string; urlIncludes?: string }
  | { kind: "scroll"; direction: "up" | "down"; amount?: number }
  | { kind: "console"; probe?: string; expression?: string; args?: unknown[] }
  | { kind: "screenshot"; label: string; fullPage?: boolean; refId?: string }
  | { kind: "upload"; refId?: string; selectors?: string[]; fileArtifactId: string }
  | { kind: "download"; refId?: string; selectors?: string[]; expectedFileName?: string };

type BrowserTaskResult = {
  workerRunKey?: string;
  browserSessionId: string;
  targetId?: string;
  status: "completed" | "partial" | "failed";
  page: BrowserPageResult;
  screenshotPaths: string[];
  trace: BrowserActionTrace[];
  artifactIds: string[];
  quality?: {
    stepReport?: VerificationReport | null;
    resultReport?: VerificationReport | null;
    replayPath?: string | null;
    errors?: string[];
  };
  error?: RuntimeError;
};
```

### 6.1 Action 分类

分两类：

1. transport primitives
2. page interactions

#### transport primitives

1. `openTarget`
2. `focusTarget`
3. `closeTarget`
4. `listTargets`
5. `status`

#### page interactions

1. `open`
2. `snapshot`
3. `click`
4. `type`
5. `wait`
6. `scroll`
7. `console`
8. `screenshot`
9. `upload`
10. `download`

---

## 7. Ref 机制

browser snapshot 需要同时生成：

1. `snapshotId`
2. `refId`
3. semantic label
4. selector fallback
5. target association

建议单独维护：

```ts
interface SnapshotRefStore {
  save(snapshot: BrowserSnapshotArtifact): Promise<void>;
  resolve(input: { browserSessionId: string; targetId: string; refId: string }): Promise<ResolvedRef | null>;
  expire(snapshotId: string): Promise<void>;
}
```

```ts
type BrowserSnapshotArtifact = {
  artifactId: string;
  snapshotId: string;
  browserSessionId: string;
  targetId: string;
  createdAt: number;
  finalUrl: string;
  title: string;
  refEntries: SnapshotRefEntry[];
};

type SnapshotRefEntry = {
  refId: string;
  role: string;
  label: string;
  tagName?: string;
  selectors?: string[];
  textAnchors?: string[];
  ordinal?: number;
};

type ResolvedRef = {
  refId: string;
  strategy: "live-ref" | "snapshot-cache" | "selector-fallback" | "semantic-fallback";
  selectors?: string[];
  label?: string;
};
```

### 7.1 Ref 恢复顺序

优先级：

1. live ref map
2. target-local recent snapshot cache
3. selector fallback
4. text/role fallback

---

## 8. Browser Artifact Model

建议所有产物统一进 artifact store：

1. screenshot
2. snapshot json
3. console result
4. downloaded file
5. action trace
3. console result
4. trace log
5. extracted file

```ts
interface BrowserArtifactStore {
  put(record: BrowserArtifactRecord): Promise<void>;
  get(artifactId: string): Promise<BrowserArtifactRecord | null>;
  listBySession(browserSessionId: string): Promise<BrowserArtifactRecord[]>;
}

type BrowserArtifactRecord = {
  artifactId: string;
  browserSessionId: string;
  targetId?: string;
  type: "snapshot" | "screenshot" | "console-result" | "downloaded-file" | "trace";
  path: string;
  createdAt: number;
  metadata?: Record<string, unknown>;
};
```

### 8.1 文件存储建议

建议先用文件存储，目录结构如下：

```text
.daemon-data/
  browser/
    profiles/
      <profileId>/
        profile.json
        chrome-profile/
    sessions/
      <browserSessionId>.json
    targets/
      <targetId>.json
    snapshots/
      <snapshotId>.json
    refs/
      <browserSessionId>/
        <targetId>.json
    artifacts/
      <browserSessionId>/
        <artifactId>-final.png
        <artifactId>-snapshot.json
        <artifactId>-console.json
    traces/
      <browserSessionId>.jsonl
```

### 8.2 文件 schema

`profiles/<profileId>/profile.json`

```json
{
  "profileId": "profile-role-operator",
  "scope": "role",
  "scopeId": "role-operator",
  "persistentDir": ".daemon-data/browser/profiles/profile-role-operator/chrome-profile",
  "loginState": "authenticated",
  "createdAt": 1774600000000,
  "updatedAt": 1774600001000
}
```

`sessions/<browserSessionId>.json`

```json
{
  "browserSessionId": "browser-session-001",
  "ownerType": "worker",
  "ownerId": "worker:browser:task-123",
  "profileId": "profile-role-operator",
  "transportMode": "local",
  "status": "ready",
  "createdAt": 1774600000000,
  "updatedAt": 1774600001000,
  "lastActiveAt": 1774600001000,
  "activeTargetId": "target-001",
  "targetIds": ["target-001"]
}
```

`targets/<targetId>.json`

```json
{
  "targetId": "target-001",
  "browserSessionId": "browser-session-001",
  "transportSessionId": "transport-001",
  "url": "https://example.com/",
  "title": "Example Domain",
  "status": "attached",
  "createdAt": 1774600000000,
  "updatedAt": 1774600001000
}
```

`refs/<browserSessionId>/<targetId>.json`

```json
{
  "browserSessionId": "browser-session-001",
  "targetId": "target-001",
  "latestSnapshotId": "snapshot-001",
  "refEntries": [
    {
      "refId": "ref-1",
      "role": "link",
      "label": "More information",
      "selectors": ["a[href*='iana']"],
      "textAnchors": ["More information"],
      "ordinal": 1
    }
  ],
  "updatedAt": 1774600002000
}
```

并在 worker 结果里只返回：

1. artifact ids
2. preview fields
3. digest

---

## 9. Session Reuse 规则

### 9.1 默认策略

1. 同一 role 的连续网页任务优先复用现有 browser session
2. 同一 worker follow-up 优先复用原 target
3. 新站点但同登录域可复用同 profile

### 9.2 重新建 session 的情况

1. profile scope 不匹配
2. transport 失效
3. session 脏状态不可恢复
4. 任务要求隔离环境

---

## 10. Hot Resume 与 Cold Resume

### 10.1 Hot Resume

依赖：

1. live browser session
2. target still attached
3. recent ref cache
4. worker session still alive

### 10.2 Cold Resume

至少需要：

1. persistent profile
2. artifact store
3. session digest
4. last known targets
5. compact worker history

当前阶段先做 hot resume，冷恢复作为第二步。

---

## 11. Permission Model

browser worker 需要独立 permission gate：

1. browser connect
2. browser open site
3. download file
4. upload file
5. read local artifact
6. write local artifact

并支持：

1. allowed
2. denied
3. required extension/profile
4. degraded fallback

### 11.1 Permission 接口

```ts
interface BrowserPermissionGateway {
  check(input: BrowserPermissionRequest): Promise<BrowserPermissionDecision>;
  apply(input: BrowserPermissionApplyRequest): Promise<BrowserPermissionDecision>;
}

type BrowserPermissionRequest = {
  threadId: string;
  roleId: string;
  workerRunKey: string;
  actionKind: BrowserAction["kind"] | "connect";
  targetUrl?: string;
};

type BrowserPermissionApplyRequest = BrowserPermissionRequest & {
  userDecision: "allow" | "deny";
};

type BrowserPermissionDecision = {
  status: "allowed" | "denied" | "requires-user-input";
  reason?: string;
};
```

---

## 12. Package 划分建议

建议按下面方式拆代码：

```text
packages/
  browser-bridge/
    src/
      session/
        browser-session-manager.ts
        browser-session-store.ts
        browser-target-store.ts
        browser-profile-store.ts
      refs/
        snapshot-ref-store.ts
      artifacts/
        browser-artifact-store.ts
      transport/
        transport-adapter.ts
        local-automation-adapter.ts
        relay-adapter.ts
        direct-cdp-adapter.ts
      actions/
        browser-action-executor.ts
        browser-action-router.ts
      gateway/
        browser-permission-gateway.ts
  worker-runtime/
    src/
      session/
        worker-session-store.ts
        worker-message-store.ts
      runtime/
        worker-runtime.ts
        worker-session-manager.ts
      handlers/
        browser-worker-handler.ts
        coder-worker-handler.ts
        finance-worker-handler.ts
```

### 12.1 第一批优先文件

建议直接先起这 8 个文件：

1. `packages/browser-bridge/src/session/file-browser-profile-store.ts`
2. `packages/browser-bridge/src/session/file-browser-session-store.ts`
3. `packages/browser-bridge/src/session/file-browser-target-store.ts`
4. `packages/browser-bridge/src/refs/file-snapshot-ref-store.ts`
5. `packages/browser-bridge/src/artifacts/file-browser-artifact-store.ts`
6. `packages/browser-bridge/src/session/browser-session-manager.ts`
7. `packages/worker-runtime/src/session/file-worker-session-store.ts`
8. `packages/worker-runtime/src/session/file-worker-message-store.ts`

---

## 13. Recovery / Timeout

browser worker 不应直接硬失败。

建议固定流程：

1. action retry budget
2. soft timeout
3. evidence-only summarize
4. hard timeout
5. return partial result + trace + error class

---

## 14. 近期实施顺序

建议按这个顺序落地：

1. `BrowserProfileStore`
2. `BrowserSessionStore`
3. `BrowserTargetStore`
4. `BrowserSessionManager`
5. `SnapshotRefStore`
6. worker `resume / interrupt / cancel`
7. browser session reuse policy

---

## 15. API / Gateway 面

为后续 UI 和 daemon 统一，建议预留下面几类接口：

```ts
GET    /worker-sessions?threadId=...
GET    /worker-sessions/:workerRunKey
GET    /browser-sessions?ownerId=...
GET    /browser-sessions/:browserSessionId/targets
POST   /worker-sessions/:workerRunKey/resume
POST   /worker-sessions/:workerRunKey/interrupt
POST   /worker-sessions/:workerRunKey/cancel
POST   /browser-sessions/acquire
POST   /browser-sessions/:browserSessionId/targets
POST   /browser-tasks/run
```

对应事件流建议保留：

1. `worker.session.updated`
2. `browser.session.updated`
3. `browser.target.updated`
4. `browser.trace.appended`
5. `browser.artifact.created`

## 16. 当前结论

如果这套协议不先定下来，后面无论接 coder、finance 还是 GUI，都会被 browser worker 的会话边界反复拖住。

所以它应该是当前第一优先级设计。
