# Prompt / Context / Compression 设计

> 更新日期：2026-03-28
> 目的：定义角色提示、上下文装配、记忆注入和压缩机制，避免系统在长任务和多角色协作中失控

---

## 1. 设计目标

这套机制要解决 5 个问题：

1. 角色如何保持稳定人格和职责
2. team handoff 后如何把任务准确交给下一个角色
3. worker 结果如何注入而不污染主上下文
4. 长对话如何在 token 接近上限时继续工作
5. 压缩后如何保留可审计性和可恢复性

---

## 2. Prompt Stack

最终送入模型的 prompt 不应该是单块文本，而应由 8 层组成。

### 2.1 Layer 1: Identity Pack

包含：

1. role identity
2. role seat
3. style hints
4. durable behavioral rules

这是长期稳定层，不随单次任务变化。

### 2.2 Layer 2: Runtime Policy

包含：

1. 可用工具
2. 可用 worker
3. 权限边界
4. retry / stop / escalation 规则

这是执行边界层。

### 2.3 Layer 3: Team Overlay

包含：

1. team name
2. lead role
3. 当前角色在 team 中的位置
4. mention/handoff 规则
5. 当前流程阶段

这是协作层。

### 2.4 Layer 4: Environment Overlay

包含：

1. workspace
2. platform
3. runtime mode
4. clock / timezone
5. environment constraints
6. capability state

这是环境层。

这里的 `capability state` 不只是本地环境信息，还应包含：

1. 哪些工具面存在
2. 哪些 connector 已授权
3. 哪些 API 已配置
4. 哪些 skill 已安装

这样 role 才能在 prompt 层明确区分：

- 可以做什么
- 理论上能做但当前不能做什么
- 下一层 fallback 应该是什么

### 2.5 Layer 5: Task Overlay

包含：

1. 当前 handoff brief
2. stop condition
3. expected output
4. verification target
5. next expected role

这是任务层。

### 2.6 Layer 6: Recent Context

包含：

1. 最近消息
2. 最近 handoff
3. 当前 flow 局部状态

这是短期工作记忆层。

### 2.7 Layer 7: Compressed Memory

包含：

1. thread summary
2. role-local working summary
3. worker outcome digest
4. retrieved long-term memory
5. artifact digest
6. scheduled task capsule digest

这是压缩后的长期上下文层。

### 2.8 Layer 8: Output Contract

包含：

1. 输出格式
2. mention 规则
3. 何时结束
4. 是否允许继续委派

这是收口层。

### 2.9 Prompt Assembler 接口

```ts
interface PromptAssembler {
  assemble(input: PromptAssemblyInput): Promise<PromptAssemblyResult>;
}

type PromptAssemblyInput = {
  thread: TeamThread;
  flow: FlowLedger;
  role: RoleSlot;
  handoff: HandoffEnvelope;
  recentTurns: TeamMessageSummary[];
  threadSummary?: ThreadSummaryRecord | null;
  roleScratchpad?: RoleScratchpadRecord | null;
  retrievedMemory?: MemoryHit[];
  workerEvidence?: WorkerEvidenceDigest[];
  budget: PromptTokenBudget;
};

type PromptAssemblyResult = {
  systemPrompt: string;
  userPrompt: string;
  tokenEstimate: PromptTokenEstimate;
  omittedSegments: OmittedPromptSegment[];
  usedArtifacts: string[];
};

type OmittedPromptSegment = {
  segment:
    | "recent-turns"
    | "thread-summary"
    | "role-scratchpad"
    | "retrieved-memory"
    | "worker-evidence";
  reason: "budget" | "empty" | "not-relevant";
};
```

---

## 3. Context Stack

上下文不应只有“最近几条消息”。

建议切成 9 段：

1. `recentTurns`
2. `flowState`
3. `roleScratchpadSummary`
4. `threadSummary`
5. `retrievedMemory`
6. `workerEvidenceDigest`
7. `capabilityStateDigest`
8. `artifactDigest`
9. `scheduledCapsuleDigest`

### 3.7 数据结构

```ts
type ThreadSummaryRecord = {
  threadId: string;
  summaryVersion: number;
  updatedAt: number;
  userGoal: string;
  stableFacts: string[];
  decisions: string[];
  openQuestions: string[];
};

type RoleScratchpadRecord = {
  threadId: string;
  roleId: string;
  updatedAt: number;
  completedWork: string[];
  pendingWork: string[];
  waitingOn?: string;
  evidenceRefs: string[];
};

type WorkerEvidenceDigest = {
  workerRunKey: string;
  workerType: string;
  status: "completed" | "partial" | "failed";
  updatedAt: number;
  findings: string[];
  artifactIds: string[];
  traceDigest?: {
    totalSteps: number;
    toolChain: string[];
    lastStep?: string;
  };
};

type MemoryHit = {
  memoryId: string;
  source: "user-preference" | "thread-memory" | "knowledge-note";
  score: number;
  content: string;
};

type CapabilityStateDigest = {
  threadId: string;
  updatedAt: number;
  availableTools: string[];
  authorizedConnectors: string[];
  configuredApis: string[];
  installedSkills: string[];
  blockedCapabilities: string[];
};

type ArtifactDigest = {
  artifactId: string;
  kind: "report" | "table" | "screenshot" | "file" | "plan";
  summary: string;
  updatedAt: number;
};

type ScheduledCapsuleDigest = {
  taskId: string;
  title: string;
  nextRunAt: number;
  summary: string;
};
```

### 3.1 `recentTurns`

只保留最近 `N` 条高相关消息。

规则：

1. 默认取最近 6-12 条
2. 优先保留当前 flow 内消息
3. 优先保留最后一次 user intent、最后一次 handoff、最后一次 worker result

### 3.2 `flowState`

必须结构化表达：

1. flow id
2. active roles
3. completed roles
4. failed roles
5. next expected role
6. hop / iteration counters

### 3.3 `roleScratchpadSummary`

每个 role 都应有自己的工作摘要：

1. 当前已完成什么
2. 还缺什么
3. 已经看过哪些重要证据
4. 正在等待哪个 worker

### 3.4 `threadSummary`

这是线程级摘要，不绑定某个 role。

应包含：

1. 用户目标
2. 当前已知事实
3. 已作出的关键决策
4. 未解决问题

### 3.5 `retrievedMemory`

只放与当前任务强相关的记忆片段。

不要把 memory 直接整段塞进 prompt。

### 3.6 `workerEvidenceDigest`

### 3.7 `capabilityStateDigest`

这一层不属于长期记忆，但它对执行决策很关键。

应只保留简洁事实：

1. 当前有哪些 connector 已授权
2. 当前有哪些 API 已配置
3. 当前有哪些 skill 已安装
4. 当前哪些关键能力被阻塞

### 3.8 `artifactDigest`

复杂任务不应依赖完整历史对话来回忆中间产物。

应把重要中间产物压成 digest，例如：

1. shortlist
2. supplier table
3. weekly digest
4. generated asset summary

### 3.9 `scheduledCapsuleDigest`

如果系统有 recurring task 或 delayed execution，就需要把未来任务本身也纳入可见上下文。

否则 role 无法判断：

1. 哪些工作已经被计划
2. 哪些工作还需要即时执行
3. 哪些后续结果会在未来自动回流

worker 返回值不应总是完整回灌。

应压缩成：

1. worker type
2. result status
3. key findings
4. artifact references
5. trace digest

---

## 4. Compression Policy

### 4.1 触发条件

至少有 4 个触发器：

1. prompt token 预算接近上限
2. recentTurns 超过条数阈值
3. worker trace 过长
4. flow 持续时间超过阈值

### 4.2 压缩对象

优先压缩：

1. 旧消息
2. 旧 worker trace
3. 旧 browser snapshot 文本

不要优先压缩：

1. 当前 user intent
2. 当前 handoff brief
3. 当前 flow state
4. 最近一次失败与恢复信息

### 4.3 压缩方式

分三种：

1. extractive compression
2. structured compression
3. evidence-preserving summary

其中最推荐的是 structured compression。

例如旧 browser trace 不要压成散文，而要压成：

```json
{
  "workerType": "browser",
  "visitedUrls": ["..."],
  "keyActions": ["open", "click", "scroll"],
  "finalTitle": "...",
  "artifacts": ["artifact://..."]
}
```

### 4.4 压缩后存放位置

不要覆盖原始消息。

应写入：

1. `threadSummary`
2. `roleScratchpadSummary`
3. `workerEvidenceDigest`
4. replay store

### 4.5 Compression 接口

```ts
interface ContextCompressor {
  compressThread(input: ThreadCompressionInput): Promise<ThreadSummaryRecord>;
  compressRoleScratchpad(input: RoleCompressionInput): Promise<RoleScratchpadRecord>;
  compressWorkerTrace(input: WorkerTraceCompressionInput): Promise<WorkerEvidenceDigest>;
}

type ThreadCompressionInput = {
  threadId: string;
  messages: TeamMessageSummary[];
  previousSummary?: ThreadSummaryRecord | null;
};

type RoleCompressionInput = {
  threadId: string;
  roleId: string;
  messages: TeamMessageSummary[];
  previousScratchpad?: RoleScratchpadRecord | null;
};

type WorkerTraceCompressionInput = {
  workerRunKey: string;
  workerType: string;
  trace: Array<Record<string, unknown>>;
  artifactIds: string[];
};
```

---

## 5. Token Budget Policy

建议每次组 prompt 前做预算分配。

示例：

1. identity/runtime/team layers: `20%`
2. task overlay + flow state: `20%`
3. recent turns: `25%`
4. compressed memory: `20%`
5. worker evidence: `10%`
6. safety margin: `5%`

当超预算时，按下面顺序裁剪：

1. worker raw trace
2. older recent turns
3. older retrieved memory
4. thread summary detail

不要裁剪：

1. output contract
2. current task overlay
3. current flow state

### 5.1 Token Budgeter 接口

```ts
interface ContextBudgeter {
  allocate(input: ContextBudgetInput): Promise<PromptTokenBudget>;
  estimate(input: ContextEstimateInput): Promise<PromptTokenEstimate>;
}

type ContextBudgetInput = {
  model: {
    provider: string;
    name: string;
    contextWindow: number;
  };
  reservedOutputTokens: number;
  mode: "lead" | "member" | "worker";
};

type PromptTokenBudget = {
  totalBudget: number;
  reservedOutputTokens: number;
  systemLayerBudget: number;
  taskLayerBudget: number;
  recentTurnsBudget: number;
  compressedMemoryBudget: number;
  workerEvidenceBudget: number;
  safetyMargin: number;
};

type ContextEstimateInput = {
  systemPrompt: string;
  userPrompt: string;
};

type PromptTokenEstimate = {
  inputTokens: number;
  outputTokensReserved: number;
  totalProjectedTokens: number;
  overBudget: boolean;
};
```

---

## 6. Compression Runtime

建议新增一个独立组件：

```ts
interface ContextCompressor {
  compressThread(input: CompressionInput): Promise<CompressedThreadState>;
  compressRoleScratchpad(input: RoleCompressionInput): Promise<RoleScratchpadSummary>;
  compressWorkerTrace(input: WorkerTraceCompressionInput): Promise<WorkerEvidenceDigest>;
}
```

配套还需要：

```ts
interface PromptAssembler {
  assemble(input: PromptAssemblyInput): Promise<PromptAssemblyResult>;
}
```

### 6.3 Store 接口

```ts
interface ThreadSummaryStore {
  get(threadId: string): Promise<ThreadSummaryRecord | null>;
  put(record: ThreadSummaryRecord): Promise<void>;
}

interface RoleScratchpadStore {
  get(threadId: string, roleId: string): Promise<RoleScratchpadRecord | null>;
  put(record: RoleScratchpadRecord): Promise<void>;
}

interface WorkerEvidenceDigestStore {
  get(workerRunKey: string): Promise<WorkerEvidenceDigest | null>;
  put(record: WorkerEvidenceDigest): Promise<void>;
  listByThread(threadId: string): Promise<WorkerEvidenceDigest[]>;
}
```

### 6.4 文件存储建议

建议目录结构如下：

```text
.daemon-data/
  context/
    thread-summaries/
      <threadId>.json
    role-scratchpads/
      <threadId>/
        <roleId>.json
    worker-evidence/
      <workerRunKey>.json
    prompt-assemblies/
      <threadId>/
        <messageId>.json
```

### 6.5 文件 schema

`thread-summaries/<threadId>.json`

```json
{
  "threadId": "thread-001",
  "summaryVersion": 3,
  "updatedAt": 1774600000000,
  "userGoal": "收集目标站点的竞品信息并给出行动建议",
  "stableFacts": ["目标站点已登录", "需要 browser worker"],
  "decisions": ["先由 operator 抓页面，再由 analyst 汇总"],
  "openQuestions": ["是否需要进一步抓定价页"]
}
```

`role-scratchpads/<threadId>/<roleId>.json`

```json
{
  "threadId": "thread-001",
  "roleId": "role-operator",
  "updatedAt": 1774600001000,
  "completedWork": ["打开目标站点", "抓到首页标题"],
  "pendingWork": ["进入 pricing 页面"],
  "waitingOn": "browser-worker",
  "evidenceRefs": ["artifact-screenshot-001", "worker-browser-001"]
}
```

`worker-evidence/<workerRunKey>.json`

```json
{
  "workerRunKey": "worker:browser:task-123",
  "workerType": "browser",
  "status": "completed",
  "updatedAt": 1774600002000,
  "findings": ["页面标题为 Example Domain", "存在 More information 链接"],
  "artifactIds": ["artifact-screenshot-001", "artifact-snapshot-001"],
  "traceDigest": {
    "totalSteps": 4,
    "toolChain": ["open", "snapshot", "click", "screenshot"],
    "lastStep": "screenshot"
  }
}
```

`prompt-assemblies/<threadId>/<messageId>.json`

```json
{
  "threadId": "thread-001",
  "messageId": "msg-001",
  "roleId": "role-lead",
  "assembledAt": 1774600003000,
  "tokenEstimate": {
    "inputTokens": 4200,
    "outputTokensReserved": 1200,
    "totalProjectedTokens": 5400,
    "overBudget": false
  },
  "omittedSegments": [],
  "usedArtifacts": ["artifact-screenshot-001"]
}
```

### 6.1 `PromptAssemblyInput`

至少包含：

1. role
2. thread
3. flow
4. current handoff
5. recent turns
6. compressed summaries
7. retrieved memory
8. worker evidence
9. token budget

### 6.2 `PromptAssemblyResult`

至少返回：

1. final system prompt
2. final user prompt
3. token estimate
4. omitted segments
5. compression artifacts used

---

## 7. 与 Worker 的关系

worker 不应该把完整原始结果直接灌进 role prompt。

更合理的规则是：

1. 小结果直接注入
2. 大结果先压缩成 digest
3. 原始产物只挂引用

例如 browser worker 只把这些注入 role：

1. final URL
2. page title
3. extracted facts
4. screenshots / artifacts
5. quality result

而不是整页 DOM 或整段 trace。

### 7.1 Worker 注入规则

建议 role runtime 只注入一层 digest：

```ts
type WorkerInjectionPolicy = {
  inlineThresholdChars: number;
  includeArtifactIds: boolean;
  includeTraceDigest: boolean;
  includeRawTrace: false;
};
```

### 7.2 Role Runtime 接口切分

建议把现有 role runtime 再拆成这几层：

```ts
interface RolePromptBuilder {
  buildIdentityPack(role: RoleSlot): Promise<string>;
  buildRuntimePolicy(role: RoleSlot): Promise<string>;
  buildTeamOverlay(input: PromptAssemblyInput): Promise<string>;
  buildTaskOverlay(input: PromptAssemblyInput): Promise<string>;
  buildOutputContract(input: PromptAssemblyInput): Promise<string>;
}

interface RoleMemoryResolver {
  loadThreadSummary(threadId: string): Promise<ThreadSummaryRecord | null>;
  loadRoleScratchpad(threadId: string, roleId: string): Promise<RoleScratchpadRecord | null>;
  loadWorkerEvidence(threadId: string): Promise<WorkerEvidenceDigest[]>;
  retrieveMemory(input: PromptAssemblyInput): Promise<MemoryHit[]>;
}
```

---

## 8. 与 Replay 的关系

压缩不是为了丢数据。

所以原始数据应保留在 replay / artifact store 中，prompt 里只引用其摘要。

这样可以同时满足：

1. 模型可持续工作
2. 用户可审计
3. 系统可回放

### 8.1 Replay 对齐字段

压缩写入后，建议 replay 里保留：

1. `sourceMessageIds`
2. `compressionInputArtifactIds`
3. `compressionOutputRecordId`
4. `compressorVersion`
5. `tokenEstimateBefore`
6. `tokenEstimateAfter`

---

## 9. 近期实施顺序

建议按这个顺序落代码：

1. `PromptAssembler`
2. `ContextBudgeter`
3. `ThreadSummaryStore`
4. `RoleScratchpadStore`
5. `WorkerEvidenceDigestStore`
6. `ContextCompressor`

---

## 10. Package 划分建议

建议按下面方式拆：

```text
packages/
  role-runtime/
    src/
      prompt/
        prompt-assembler.ts
        role-prompt-builder.ts
      context/
        context-budgeter.ts
        role-memory-resolver.ts
      compression/
        context-compressor.ts
  team-store/
    src/
      context/
        file-thread-summary-store.ts
        file-role-scratchpad-store.ts
        file-worker-evidence-digest-store.ts
        file-prompt-assembly-log-store.ts
```

### 10.1 第一批优先文件

建议直接先起这 7 个文件：

1. `packages/role-runtime/src/prompt/prompt-assembler.ts`
2. `packages/role-runtime/src/context/context-budgeter.ts`
3. `packages/role-runtime/src/context/role-memory-resolver.ts`
4. `packages/role-runtime/src/compression/context-compressor.ts`
5. `packages/team-store/src/context/file-thread-summary-store.ts`
6. `packages/team-store/src/context/file-role-scratchpad-store.ts`
7. `packages/team-store/src/context/file-worker-evidence-digest-store.ts`

---

## 11. Gateway / API 面

建议预留下面几类接口：

```ts
GET  /thread-summaries/:threadId
GET  /role-scratchpads/:threadId/:roleId
GET  /worker-evidence?threadId=...
POST /prompt/assemble
POST /context/compress/thread
POST /context/compress/role
POST /context/compress/worker
```

事件流建议保留：

1. `thread.summary.updated`
2. `role.scratchpad.updated`
3. `worker.evidence.updated`
4. `prompt.assembly.completed`

## 12. 当前结论

当前系统离最终机制最远的地方，不是 team handoff，也不是 browser action。

而是：

1. prompt layering 还太薄
2. context stack 还没成立
3. compression policy 基本不存在

所以在持续开发前，必须把这套机制补清楚。
