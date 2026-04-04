# TurnkeyAI 架构深度审查报告

> 审查日期：2026-04-04  
> 审查范围：`fakechris/turnkeyai` 全仓库  
> 审查视角：Staff+ 工程师对抗性建设性审查

---

## 1. 执行摘要

**架构基本面是否健全？** 是的——但有明确的结构性上限。

核心运行时分层 `Team → Role → Worker → BrowserBridge` 是清晰的，类型契约覆盖率极高（`core-types/team.ts` 2442 行，几乎所有接口都有显式类型），包间依赖方向基本正确。仓库在 "可运行的多角色 runtime 骨架" 这一目标上确实达到了 95%+ 的完成度。

**最强之处：**
- 类型系统的覆盖力度——几乎所有运行时概念都有显式类型契约，且贯穿到 store / event / replay / recovery 全链路。
- 恢复 / replay / operator surface 的设计野心和实际覆盖深度远超同类项目。
- browser session 的 ownership / lease / resume / evict 语义建模相当完整。

**最危险之处：**
- `daemon.ts` 是一个 3452 行的 god file，同时承担 composition root + HTTP 路由 + recovery orchestration + runtime 查询 + relay 协议 + 业务逻辑。
- 文件级持久化的 atomicity 和 concurrency 保证在高并发场景下会失败。
- Worker runtime 完全基于内存（`InMemoryWorkerRuntime`），进程崩溃后 worker session 全部丢失。

**最先会在哪里崩溃：**
1. `daemon.ts` 在任何新增功能时都会产生合并冲突和认知过载
2. 多并发 flow 下 file-backed store 的 read-modify-write 竞态
3. 进程重启后 worker state 全部丢失，但 recovery 系统仍尝试 resume 已不存在的 session

---

## 2. 架构映射

### 主要包

| 包 | 定位 | 实际行为 |
|---|---|---|
| `core-types` | 共享类型契约 | 2442 行的 team.ts 是真正的 "系统 schema"，同时包含 mutex、file-store utils |
| `team-runtime` | Team / Flow / Scheduling 运行时 | CoordinationEngine 是核心调度器，含 handoff / fan-out / shard merge |
| `role-runtime` | Prompt / Context / Role 执行 | PolicyRoleRuntime 负责 worker 调用 + governance 评估 + prompt 组装 |
| `worker-runtime` | Worker 注册/生命周期 | InMemoryWorkerRuntime 管理 spawn/send/resume/interrupt/cancel |
| `browser-bridge` | Browser session/target/transport | 三种 transport adapter + session manager + artifact store |
| `team-store` | 文件级持久化 | 所有 file-backed store，含 context / governance / recovery / scheduled 子目录 |
| `llm-adapter` | 多模型适配器 | registry + gateway + openai/anthropic client |
| `qc-runtime` | 验证 / 诊断 / replay | regression harness / soak / acceptance / validation profile + operator inspection |
| `app-gateway` | 本地 daemon 入口 | **3452 行的 god file**，所有组装 + 所有 HTTP 路由 + recovery action 逻辑 |
| `tui` | 终端调试客户端 | 单文件 TUI |
| `cli` | 公开 CLI 包 | daemon + tui 的 npm 发布壳 |
| `browser-relay-peer` | Chrome relay 扩展 | relay 浏览器端 peer |

### 主执行路径

```
User POST /messages
  → daemon.ts: coordinationEngine.handleUserPost()
  → CoordinationEngine: buildFlow() → dispatchToLead()
  → dispatchToRole() → buildHandoff → enqueue to RoleRunCoordinator
  → InlineRoleLoopRunner.ensureRunning()
  → PolicyRoleRuntime.runActivation()
    → promptPolicy.buildPacket()
    → workerRuntime.spawn() + send() | resume()
    → responseGenerator.generate()
    → buildMessage → persist → reply via onRoleReply callback
  → CoordinationEngine.handleRoleReply()
    → handoffPlanner.validateMentionTargets()
    → applyRecoveryDecision() | dispatchToRole() (handoff)
```

### 主持久化路径

```
file-backed JSON stores → writeJsonFileAtomic (rename-based)
  .daemon-data/threads/*.json
  .daemon-data/messages/*.json
  .daemon-data/flows/*.json
  .daemon-data/runs/*.json
  .daemon-data/runtime-chains/*.json
  .daemon-data/replays/*.json
  .daemon-data/recovery-runs/*.json
  .daemon-data/browser-state/*.json
  .daemon-data/browser-artifacts/*.json
  .daemon-data/context/**/*.json
  .daemon-data/governance/**/*.json
  .daemon-data/scheduled-tasks/*.json
```

### Operator / Replay / Recovery 路径

```
ReplayRecord → FileReplayRecorder → buildReplayInspectionReport()
  → buildReplayRecoveryPlans() → RecoveryRun
  → executeRecoveryRunAction() → scheduledTaskRuntime
  → coordinationEngine.handleScheduledTask()
  → replay + recovery timeline + operator triage
```

### Browser Transport 路径

```
BrowserBridgeFactory → LocalAutomationAdapter | RelayAdapter | DirectCdpAdapter
  → BrowserSessionManager (ownership / lease / profile)
  → BrowserTarget (lifecycle / activate / close)
  → BrowserArtifactStore / SnapshotRefStore
```

---

## 3. Top 10 发现

### F1 — daemon.ts 是不可维护的 God Object

- **严重度：** S0
- **置信度：** 高
- **领域：** architecture
- **发现：** `packages/app-gateway/src/daemon.ts` 有 3452 行，同时包含：(a) 30+ 依赖的组装 (b) 50+ HTTP 路由处理 (c) recovery orchestration 核心逻辑 (d) runtime chain 查询聚合 (e) browser session 路由 (f) relay protocol 路由 (g) validation/soak/regression runner 路由 (h) 全部辅助函数。
- **为什么重要：** 任何新功能/bugfix 都在同一个文件中。多人并行开发时合并冲突几乎必然发生。单个函数如 `executeRecoveryRunAction` 超过 350 行，内含多层嵌套的 try/catch + store 写入 + event 追加 + progress 记录。
- **证据：** `wc -l daemon.ts` = 3452。`executeRecoveryRunAction` 横跨 L2790–L3139。
- **建议：** 拆分为：(1) `composition-root.ts`（纯组装）(2) `routes/` 目录下按职能分文件 (3) `recovery-action-orchestrator.ts`（recovery dispatch 逻辑）(4) `runtime-query-service.ts`（运行时聚合查询）
- **重构风险：** 中低——拆分是机械性的，不涉及接口变更。

### F2 — Worker 状态完全基于内存，无持久化

- **严重度：** S0
- **置信度：** 高
- **领域：** persistence / recovery
- **发现：** `InMemoryWorkerRuntime` 使用 `Map<string, {...}>` 保存所有 worker session。进程崩溃 / 重启后全部丢失。但 recovery 系统（`deriveRecoveryBrowserSessionHint`、continuity 路径）仍会尝试 resume 已不存在的 worker session。
- **为什么重要：** 在 "可以长期运行" 的目标下，这是核心矛盾。recovery 系统的 dispatch 会生成 `continuityMode: "resume-existing"` 的 scheduled task，但对应 worker session 已经不存在。
- **证据：** `in-memory-worker-runtime.ts` L33: `private readonly sessions = new Map<...>()`。
- **建议：** (1) 短期：为 `WorkerSessionState` 增加 file-backed 持久化 (2) 中期：引入 durable execution journal (3) recovery dispatch 逻辑需要在 worker session 不存在时显式 fallback 到 fresh spawn
- **重构风险：** 中——需要引入持久化且保证 worker 状态机语义不变。

### F3 — FileTeamMessageStore 的 append 是 read-all + push + write-all

- **严重度：** S1
- **置信度：** 高
- **领域：** persistence / performance
- **发现：** `FileTeamMessageStore.append()` 每次 append 都读取整个 thread 的所有消息到内存，push 一条，再全量写回。随着对话增长，这会成为严重的性能瓶颈和 I/O 放大。
- **为什么重要：** 一个有 1000 条消息的 thread，每次 append 都要反序列化 + 序列化全部消息。在并发 flow 下 mutex 竞争加剧。
- **证据：** `file-team-message-store.ts` L20-26: `readThreadMessages → push → writeThreadMessages`。
- **建议：** 改为 append-only JSONL 格式，或至少做分页/分段存储。
- **重构风险：** 中——需要迁移现有数据格式。

### F4 — RelayPayload 存在大量语义重复字段

- **严重度：** S1
- **置信度：** 高
- **领域：** api / architecture
- **发现：** `RelayPayload` 接口同时维护旧路径（`relayBrief`、`recentMessages`、`instructions`、`continuationContext`、`mergeContext`、`parallelContext`、`dispatchPolicy`、`preferredWorkerKinds`）和新的结构化路径（`intent`、`continuity`、`coordination`、`constraints`）。`CoordinationEngine.dispatchToRole()` L164-225 对每个字段同时写入两个位置。
- **为什么重要：** 读取方需要知道从哪个路径读——`getContinuationContext()` 等 helper 已经在做 fallback 逻辑——但这是纯语义债。新增任何 dispatch 语义都要同时更新两处。
- **证据：** `coordination-engine.ts` L164-250：每个字段写两次。`core-types/team.ts` `RelayPayload` 接口有 ~15 个字段。
- **建议：** 完成迁移到结构化路径 (`intent` / `continuity` / `coordination` / `constraints`)，删除顶层冗余字段，统一读取 helper。
- **重构风险：** 中——需要全仓库 grep 所有读取点。

### F5 — 跨 store 操作无事务保证

- **严重度：** S1
- **置信度：** 高
- **领域：** persistence / recovery
- **发现：** `CoordinationEngine.handleUserPost()` 依次写入 messageStore → flowLedgerStore → runtimeChainRecorder → dispatchToRole（又写 flowLedgerStore + roleRunStore）。任一步骤失败会留下部分写入的状态。例如 message 已写但 flow 未写，或 flow 已写但 handoff 未 enqueue。
- **为什么重要：** 进程崩溃或异常会导致状态不一致——可能出现"孤儿 flow"或"孤儿 message"。
- **证据：** `coordination-engine.ts` L77-94。
- **建议：** (1) 短期：在 daemon 启动时增加 orphan detection + reconciliation (2) 中期：引入 write-ahead log 或 outbox pattern (3) 文档化当前的 crash-recovery 边界
- **重构风险：** 高——事务语义变更影响全链路。

### F6 — ID 生成器非全局唯一

- **严重度：** S1
- **置信度：** 高
- **领域：** persistence / concurrency
- **发现：** `createIdGenerator()` 使用 `Date.now() + ++seq` 生成 ID。在多进程部署或高并发场景下，`Date.now()` 分辨率不足（毫秒级），可能产生重复 ID。
- **为什么重要：** 如果两个请求在同一毫秒内到达且 seq 起始值相同（进程重启），将产生 ID 碰撞。
- **证据：** `daemon.ts` L1947-1958。
- **建议：** 使用 `crypto.randomUUID()` 或至少加入 random 后缀。
- **重构风险：** 低——纯替换。

### F7 — Daemon HTTP 路由用裸 regex 匹配，无框架、无 OpenAPI 契约

- **严重度：** S2
- **置信度：** 高
- **领域：** api
- **发现：** daemon 的 50+ 路由全部用 `if (req.method === "GET" && url.pathname === "/xxx")` 或 `url.pathname.match(/.../)` 匹配。无路由表、无中间件、无参数校验框架、无 OpenAPI spec。
- **为什么重要：** (1) 新增路由极易遗漏参数校验 (2) 无法自动生成文档 (3) 路由优先级依赖 if 顺序——`browserSessionTargetsMatch` 在 L1559 GET 和 L1571 POST 两处匹配同一个 regex，POST 分支依赖 GET 分支的 regex 变量名，极易出错。
- **证据：** L1559-1591 `browserSessionTargetsMatch` 同一 regex 两用。
- **建议：** 引入轻量路由表（不需要 Express 级框架，一个 `{ method, pattern, handler }[]` 数组即可）。
- **重构风险：** 低——机械性重构。

### F8 — 测试覆盖偏重 happy-path，缺乏并发 / crash / 恢复测试

- **严重度：** S2
- **置信度：** 高
- **领域：** testing
- **发现：** 365 个测试全部通过，但审查测试内容发现：(1) 无任何并发竞态测试 (2) 无进程 crash-restart 后的状态恢复测试 (3) 无文件 I/O 失败注入测试 (4) bounded regression / soak / acceptance harness 是 "pure function assertion"，不涉及真实 I/O。
- **为什么重要：** 当前测试保证功能正确性但不保证可靠性。
- **证据：** `bounded-regression-harness.ts`、`soak-suite.ts` 等均为纯函数验证。
- **建议：** 增加 (1) 并发 flow enqueue 竞态测试 (2) 文件写入中途 crash 的 recovery 测试 (3) worker session 重启后 resume 的降级测试 (4) daemon HTTP 端点 contract 测试
- **重构风险：** 低——增量添加。

### F9 — Auth 模型过于简单，无 per-endpoint 权限

- **严重度：** S2
- **置信度：** 高
- **领域：** security
- **发现：** daemon 的 auth 模型是单一 bearer token (`TURNKEYAI_DAEMON_TOKEN`)，且 `/health` 路由绕过认证。所有已认证请求对所有端点有完全权限。recovery dispatch、browser session spawn、regression runner 等敏感操作与消息读取共享同一权限级别。
- **为什么重要：** 一旦 daemon 暴露到非 localhost 网络，任何持有 token 的调用者可以 dispatch recovery、evict browser sessions、运行 regression。
- **证据：** `daemon.ts` L2069-2085 `isAuthorizedRequest()`。
- **建议：** (1) 至少区分 read-only / admin / operator 三个角色 (2) 敏感端点（recovery action、scheduled task trigger、browser evict）需要显式 admin 权限
- **重构风险：** 中——需要设计权限模型。

### F10 — core-types/team.ts 是 2442 行的单一类型文件

- **严重度：** S2
- **置信度：** 高
- **领域：** architecture
- **发现：** 所有运行时类型——从基础的 `TeamMessage` 到复杂的 `RecoveryRun`、`ReplayConsoleReport`、`OperatorTriageReport`——全部在同一个 `team.ts` 中。
- **为什么重要：** 虽然 TypeScript 编译器不在乎文件大小，但开发者的认知负担极大。新增类型时需要滚动 2000+ 行。更重要的是，所有包都依赖同一个导出——`import from "@turnkeyai/core-types/team"` 是仓库中最普遍的导入。
- **证据：** `wc -l team.ts` = 2442。
- **建议：** 按 domain 拆分：`thread.ts`、`flow.ts`、`runtime-chain.ts`、`browser.ts`、`recovery.ts`、`replay.ts`、`governance.ts`、`prompt.ts`，保留 `index.ts` re-export。
- **重构风险：** 低——纯机械拆分 + re-export。

---

## 4. 逐包审查

### `core-types`

- **预期职责：** 纯类型契约 + 极少量 util
- **实际职责：** 类型契约（team.ts 2442 行）+ async-mutex（31 行）+ file-store-utils（36 行）+ browser-session-payload decode + continuation-semantics helpers + recovery-operator-semantics + shard-result-analysis
- **泄漏/隐藏耦合：** `file-store-utils` 包含实际 I/O 操作（readFile / writeFile / rename），不应属于 "core-types"。`async-mutex` 是运行时工具，与类型契约包定位不符。
- **建议：** (1) `file-store-utils` + `async-mutex` 移入 `team-store` 或新建 `runtime-utils` 包 (2) `team.ts` 按 domain 拆分

### `team-runtime`

- **预期职责：** Team / Flow / Scheduling 核心运行时
- **实际职责：** 基本匹配。CoordinationEngine（1367 行）是核心调度器。
- **泄漏/隐藏耦合：** `CoordinationEngine` 直接依赖 `decodeBrowserSessionPayload`——浏览器语义泄漏到 team 层。`session-memory-refresh-worker` 是 context 管理逻辑，更适合归入 role-runtime 或 context 子系统。
- **建议：** (1) browser session hint resolution 移入 browser-bridge (2) CoordinationEngine 的 fan-out/shard 逻辑考虑提取为独立的 `ShardCoordinator`

### `role-runtime`

- **预期职责：** Prompt 组装 + 角色执行
- **实际职责：** 基本匹配。PolicyRoleRuntime（1004 行）是核心执行点。
- **泄漏/隐藏耦合：** PolicyRoleRuntime 同时负责 worker 调度 + governance 评估 + evidence 持久化 + replay 记录 + event 发布。单一方法 `runActivation()` 横跨 155 行。
- **建议：** 将 worker governance pipeline 提取为独立的 `WorkerGovernancePipeline`。

### `worker-runtime`

- **预期职责：** Worker 生命周期管理
- **实际职责：** 匹配。但 `LocalWorkerRuntime` 只是 `InMemoryWorkerRuntime` 的 re-export。
- **泄漏/隐藏耦合：** 无明显泄漏。
- **建议：** 增加 file-backed session state 持久化。

### `browser-bridge`

- **预期职责：** Browser session / target / transport
- **实际职责：** 基本匹配。结构最清晰的包之一。
- **泄漏/隐藏耦合：** transport adapter 接口清晰。但 `RelayBrowserAdapter` 直接依赖 daemon 的 relay gateway 实现细节。
- **建议：** relay gateway 应作为注入依赖而非通过 `maybeGetRelayGateway()` 的 downcast 获取。

### `team-store`

- **预期职责：** 文件级持久化
- **实际职责：** 匹配。每个 store 一个文件，接口实现对齐 core-types 定义。
- **泄漏/隐藏耦合：** 无明显泄漏。
- **建议：** message store 改为 append-only 格式。

### `qc-runtime`

- **预期职责：** 验证 / 诊断 / replay
- **实际职责：** 匹配，但功能密度极高——41 个文件，几乎每个都是独立的 harness/policy/inspector。
- **泄漏/隐藏耦合：** `replay-inspection.ts` 和 `runtime-chain-inspection.ts` 的查询逻辑被 daemon.ts 大量调用，实际上是 daemon 的 "查询层"。
- **建议：** 考虑将 operator/replay/runtime 查询函数提升为显式的 "query service" 层。

### `app-gateway`

- **预期职责：** 本地 daemon 入口
- **实际职责：** 实际是全仓库的 god object（见 F1）。
- **建议：** 彻底拆分。

---

## 5. API 表面审查

### 不一致性

| 问题 | 示例 |
|---|---|
| 路由命名不统一 | `/flows-summary` vs `/replay-summary` vs `/operator-summary`（有些用连字符，有些不用） |
| GET vs POST 不一致 | `/scheduled-tasks/trigger-due` 是 POST（合理），但 `/regression-cases/run` 也是 POST |
| 资源模型混乱 | `/runtime-chains` / `/runtime-active` / `/runtime-waiting` / `/runtime-failed` / `/runtime-stale` / `/runtime-attention` / `/runtime-summary` / `/runtime-progress` 本应是 `/runtime-chains?state=active` 的 query 参数 |
| limit 校验不统一 | 大部分用 `parsePositiveLimit`（默认 100），`/recovery-runs` 用 `parsePositiveInteger`（默认 null） |

### 缺失验证

- `POST /messages` 不校验 `body.threadId` 或 `body.content` 是否为空字符串
- `POST /browser-sessions/spawn` 不限制 `actions` 数组大小
- `POST /relay/peers/register` 不限制 `capabilities` 数组大小
- `POST /scheduled-tasks` 不校验 `schedule.expr` 是否为合法 cron 表达式

### 缺失幂等性

- `POST /messages` 无请求去重机制——重复提交相同消息会产生重复 flow
- `POST /browser-sessions/spawn` 无幂等 key
- `POST /recovery-runs/{id}/{action}` 使用 mutex + 状态检查实现了基本幂等（F+ 级，但依赖内存 mutex，进程重启后失效）

### 过度暴露的调试表面

- `/regression-cases/run`、`/soak-cases/run`、`/failure-cases/run`、`/acceptance-cases/run`、`/validation-cases/run`、`/release-readiness/run` 等 12+ 个 test runner 端点与生产端点共享同一权限级别
- `/relay/peers/register` 允许任何已认证请求注册新 peer——应限制为内部 relay peer

### 版本化痛点

- 当前无任何 API 版本前缀。一旦需要变更资源 schema（如 `FlowLedger` 新增/删除字段），所有客户端同时 break。
- 建议至少增加 `/v1/` 前缀。

---

## 6. Recovery / Replay / Continuity 审查

### "Resume" 在此仓库中的真实含义

"Resume" 在不同层有不同语义：

| 层 | "Resume" 含义 | 持久性 |
|---|---|---|
| Worker | `InMemoryWorkerRuntime.resume()` — 从内存 session 中恢复 | **非持久化** |
| Browser Session | `BrowserSessionManager.resumeSession()` — 重新获取 lease | 持久化（file-backed session/target store）|
| Recovery Run | `executeRecoveryRunAction("resume")` — 通过 scheduled task 重新 dispatch | 持久化（recovery run store + replay）|
| CoordinationEngine | `continuityMode: "resume-existing"` — 尝试复用已有 worker session | **依赖内存 worker 状态** |

### 持久 vs 非持久

- **持久：** Flow / Message / Thread / RuntimeChain / RuntimeChainStatus / Replay / RecoveryRun / RecoveryRunEvent / BrowserSession / BrowserTarget / BrowserProfile / ScheduledTask / Context (summary/memory/scratchpad/journal)
- **非持久：** Worker session state / TeamEventBus (InMemoryTeamEventBus) / Flow mutex state

### Recovery 逻辑可信度

- **可信：** RecoveryRun 的状态机（planned → running → recovered/failed/aborted）有完整的 guard 逻辑（`recovery-run-guards.ts`）和 operator semantics（`recovery-operator-semantics.ts`）。
- **仅启发式：** `buildRecoveryRuns()` 通过匹配 replay record 的 groupId 和 taskId 来 "推断" recovery 状态——这是 eventually consistent 的，不是严格的因果链。如果 replay record 延迟写入或丢失，recovery 状态会失真。
- **可能误导 operator 的场景：** recovery dispatch 成功但后续 flow 执行失败，recovery run 状态可能停留在 "running" 直到 stale reaper 5 分钟后将其标记为 failed。这段时间内 operator 看到的状态与实际不符。

### Replay 可能误导 operator 的场景

- Replay record 是 append-only 的，但 `buildReplayInspectionReport()` 对同一 groupId 取最新的 record 作为当前状态。如果最新 record 是 "completed" 但实际执行已回退，replay console 会显示 "resolved"。
- Browser continuity summary 从 replay metadata 中提取 session/target 信息，但这些信息可能已 stale（session 已被 evict 或 target 已 close）。

---

## 7. 持久化 / 并发审查

### 真正的 Source of Truth

| 概念 | Source of Truth | 投影/缓存 |
|---|---|---|
| Thread | `FileTeamThreadStore` | TeamRouteMap（查询索引） |
| Message | `FileTeamMessageStore` | SummaryBuilder（最近消息投影） |
| Flow | `FileFlowLedgerStore` | FlowConsoleReport |
| RoleRun | `FileRoleRunStore` | — |
| Worker Session | **内存 Map** | — |
| Browser Session | `FileBrowserSessionStore` | — |
| Runtime Chain | `FileRuntimeChainStore` + `FileRuntimeChainStatusStore` | RuntimeSummaryReport |
| Replay | `FileReplayRecorder` | ReplayInspectionReport |
| Recovery Run | `FileRecoveryRunStore` | RecoveryConsoleReport |

### 投影漂移风险

- `loadRecoveryRuntime()` 每次调用都重新从 replay records + existing runs 计算 recovery runs（`buildRecoveryRuns()`），然后与已存储的 runs 对比并 sync。如果两个请求并发调用 `syncRecoveryRuntime()`，可能产生竞态写入。
- `RuntimeChainStatus` 是由多个 recorder（runtimeChainRecorder、runtimeStateRecorder）分别写入的，没有统一的 timestamp ordering 保证。

### 锁的充分性

- `KeyedAsyncMutex` 是进程内的 Promise-based mutex，进程重启后锁状态丢失。
- `CoordinationEngine` 对 flow 操作使用 `flowMutex`，对 message append 使用 `FileTeamMessageStore` 的 `threadMutex`——但两者是独立的锁，flow 更新和 message 写入之间的原子性无法保证。
- `BrowserSessionManager` 有三个独立的 mutex（ownerMutex、profileMutex、sessionMutex），锁粒度合理，但锁获取顺序没有形式化保证——理论上存在死锁风险（虽然当前代码路径不太可能触发）。

### Atomicity 弱点

- `writeJsonFileAtomic` 使用 write-to-temp + rename，这在单个文件级别是原子的（依赖文件系统的 rename 原子性保证）。
- 但跨文件操作（如 `handleUserPost` 写 message → flow → chain）不是原子的。
- `FileTeamMessageStore.append()` 的 read-all + push + write-all 在高并发下即使有 mutex，也有性能问题（mutex 串行化导致 throughput 下降）。

### Crash / Restart 不安全场景

1. **Worker session 全部丢失** — 所有 in-flight worker 执行的 state、progress、continuation digest 消失。
2. **InMemoryTeamEventBus 全部丢失** — 所有未消费的 event 消失，audit log 断裂。
3. **Recovery run 的 stale reaper** 依赖 `RECOVERY_RUN_STALE_AFTER_MS = 5min`——如果进程在 recovery dispatch 后 1 分钟 crash 再重启，stale reaper 要再等 4 分钟才能检测到。

---

## 8. Browser Transport 审查

### Transport 抽象

```typescript
interface BrowserTransportAdapter extends BrowserBridge {
  readonly transportMode: BrowserTransportMode;
  readonly transportLabel: string;
}
```

干净。三种实现 (local / relay / direct-cdp) 在工厂函数中切换。

### Ownership 模型

- session owner: `user | thread | role | worker`
- owner 检查通过 `requireBrowserSessionAccess()` 实现——仅检查 thread 归属，不检查 role/worker 的运行状态。
- **漏洞：** 如果 role/worker 已经完成或失败，其拥有的 browser session 仍然可以被 API 访问。没有 "session 随 owner 生命周期自动 revoke" 的机制。

### Lease / Reconnect 语义

- lease TTL 默认 5 分钟。lease 冲突通过 `claimSessionLease()` 中的 `isLeaseActive() + leaseHolderRunKey` 检查实现。
- **风险：** lease 过期检查依赖 `this.now()` 与 `leaseExpiresAt` 的比较。如果时钟漂移（NTP 调整）或跨进程时钟不同步，lease 行为会异常。

### Target 生命周期

- target 状态：`open | attached | detached | closed`
- `ensureBrowserTarget()` 处理创建/更新/状态迁移，逻辑完整。
- `reselectActiveTarget()` 在 target close 时自动选择替代 target——合理。
- **风险：** target detach 后的 reattach 路径依赖 transport adapter 的 reconnect 能力，但 transport adapter 接口中没有显式的 `reconnect()` 方法——reconnect 语义散落在各 adapter 实现中。

### 安全 / 隔离

- browser session 的 owner 检查 (`requireBrowserSessionAccess`) 只在 daemon HTTP 层实现——如果直接调用 `browserBridge` API（如 worker handler 内部），绕过了 owner 检查。
- relay peer 注册 (`/relay/peers/register`) 对任何已认证请求开放——恶意 peer 可以注册并拦截 action request。

### 扩展性

- transport adapter 接口足够简洁，新增 transport（如 WebSocket direct）只需实现 `BrowserTransportAdapter`。
- 但 relay protocol（pull-based polling）的设计决策将限制延迟——每个 action 需要一个 poll 周期的延迟。

---

## 9. Governance / Trust / Policy 审查

### 权限治理

- `PermissionGovernancePolicy.evaluate()` 基于 `workerType + payload + apiDiagnosis + transportAudit` 评估权限。
- `DefaultPermissionGovernancePolicy` 的实际实现是 **permissive default**——未配置策略时，所有操作默认 granted。
- 权限结果缓存到 `PermissionCacheStore`，TTL 为 10-30 分钟。
- **这是 enforce-before-use，不是 annotate-after-use。** 权限评估发生在 worker 执行完成后、结果被纳入 prompt 之前。

### Evidence Trust

- `EvidenceTrustPolicy.assess()` 基于 worker status + permission + apiDiagnosis + transportAudit 评估信任级别。
- 信任级别：`promotable | observational`。
- **风险：** `defaultTrustAssessment()` 函数中，如果 permission granted + worker completed + API diagnosis all ok，trust 默认为 `promotable`。但这没有验证 worker 输出的语义正确性——一个成功完成但返回错误数据的 worker 仍然会被标记为 promotable。

### Prompt Admission

- `PromptAdmissionPolicy.decide()` 基于 trust + permission + apiDiagnosis 决定 worker 结果是否进入 prompt。
- 三种模式：`full | summary_only | blocked`。
- 这是最后一道门——在此之后 worker 结果直接进入 prompt context。

### Browser/Tool 结果过度信任

- browser worker 的 `BrowserTaskResult` 包含 `page.textExcerpt`、`trace`、`screenshotPaths`——这些内容直接进入 worker evidence digest，经 prompt admission 后进入 LLM prompt。
- 没有对 `textExcerpt` 内容的 sanitization 或长度限制——恶意网页可以注入 prompt 注入攻击内容。

### 语义边界

| 概念 | 位置 | 明确度 |
|---|---|---|
| Summary | ThreadSummaryStore | 线程级摘要，定期更新 |
| Memory | ThreadMemoryStore | 长期偏好/约束 |
| Session Memory | ThreadSessionMemoryStore | 会话级活跃状态 |
| Scratchpad | RoleScratchpadStore | 角色级工作进展 |
| Journal | ThreadJournalStore | 按日期的工作日志 |
| Evidence Digest | WorkerEvidenceDigestStore | Worker 执行结果摘要 |
| Replay | FileReplayRecorder | 执行记录/审计 |

边界基本清晰，但 session memory 和 scratchpad 的更新触发条件不够明确——由 `ContextStateMaintainer` 在不同时机触发，可能出现内容重叠。

---

## 10. 测试和验证审查

### 测试良好覆盖的区域

- core-types 的 continuation semantics、recovery operator semantics、browser session payload、shard result analysis
- CoordinationEngine 的 handoff/dispatch/fan-out/merge 逻辑
- PolicyRoleRuntime 的 worker 调用 + governance pipeline
- InMemoryWorkerRuntime 的 spawn/send/resume/interrupt/cancel 状态机
- BrowserSessionManager 的 ownership / lease / resume / evict

### 测试覆盖薄弱的区域

- daemon HTTP 路由的端到端测试——当前为零
- file store 的并发写入测试——当前为零
- 跨 store 事务失败测试——当前为零
- 进程 crash + restart 后的状态恢复测试——当前为零

### 未测试但高风险的区域

- `executeRecoveryRunAction()` 的完整路径（350+ 行，涉及多 store 写入 + scheduled task dispatch）
- relay transport 的 peer registration / heartbeat / target report / action polling 真实网络交互
- `loadRuntimeChainEntriesForThread()` 的 N+1 查询模式在大量 chains 时的性能

### 最应先添加的 10 个测试

1. daemon POST /messages 端到端 contract test（验证 flow 创建 + message 持久化 + role dispatch）
2. FileTeamMessageStore 并发 append 竞态测试
3. CoordinationEngine.handleUserPost() 中 flowLedgerStore.put() 失败后的状态一致性
4. InMemoryWorkerRuntime 进程重启后 resume 降级行为
5. BrowserSessionManager lease 过期后的正确行为
6. executeRecoveryRunAction 的 complete 路径（dispatch + success + recovery run status transition）
7. executeRecoveryRunAction 的 failure 路径（dispatch 异常 + recovery run failure recording）
8. relay peer 注册后 target report + pull-actions + action-result 的集成测试
9. PromptAdmissionPolicy 对恶意 browser textExcerpt 的处理测试
10. ID 碰撞测试（高并发下 createIdGenerator 的唯一性）

---

## 11. 重构计划

### 快速胜利（1–3 天）

1. **拆分 daemon.ts 路由**：将 50+ 路由按 domain 拆分到 `routes/thread.ts`、`routes/browser.ts`、`routes/replay.ts`、`routes/recovery.ts`、`routes/validation.ts`、`routes/relay.ts`。
2. **替换 ID 生成器**：`createIdGenerator()` 改用 `crypto.randomUUID()`。
3. **拆分 core-types/team.ts**：按 domain 拆分为 8-10 个文件 + re-export index。
4. **移动 file-store-utils + async-mutex** 出 core-types 包。
5. **增加 `/v1/` API 前缀**。

### 中等重构（1–2 周）

1. **Worker session 持久化**：为 `WorkerSessionState` 增加 file-backed store，`InMemoryWorkerRuntime` 改为 write-through cache。
2. **Message store 改为 append-only JSONL**：避免 read-all + write-all。
3. **清理 RelayPayload 重复字段**：完成迁移到结构化路径，删除顶层冗余字段。
4. **提取 recovery action orchestrator**：从 daemon.ts 中提取 `executeRecoveryRunAction` + 相关函数为独立模块。
5. **增加 daemon endpoint contract 测试**：对核心的 10 个 endpoint 增加 HTTP level 测试。

### 深度结构变更（1–2 个月）

1. **引入 write-ahead log / outbox pattern**：解决跨 store 原子性问题。
2. **TeamEventBus 持久化**：将 InMemoryTeamEventBus 改为 file-backed，支持进程重启后 event replay。
3. **Durable worker execution journal**：worker execution 的每一步都记录到持久化日志，支持 crash-restart 后的精确恢复。
4. **Prompt injection defense**：在 browser textExcerpt 进入 prompt 前增加 sanitization + 长度限制 + content policy。
5. **Multi-process safe persistence**：将 file-backed store 的锁机制从进程内 AsyncMutex 升级为文件锁（flock），或迁移到 SQLite。

---

## 12. 最终裁定

| 维度 | 判断 |
|---|---|
| **保持现状** | core-types 的类型系统设计、browser session ownership model、transport adapter 抽象、governance policy pipeline、replay/recovery 的概念模型 |
| **尽快重构** | daemon.ts god file 拆分、RelayPayload 重复字段清理、ID 生成器替换、team.ts 拆分、message store append 模式 |
| **必须重新设计** | worker runtime 持久化（当前的纯内存模式与 recovery 系统的 resume 语义矛盾）、跨 store 事务保证（当前依赖 "不崩溃" 假设） |
| **裁定置信度** | **高** — 基于完整代码审查（3452 行 daemon + 2442 行 core-types + 1367 行 coordination-engine + 所有关键运行时文件）、typecheck（通过，1 个非关键 TS 错误）、test 运行（365/365 通过）和执行路径追踪得出。 |

### 一句话总结

> 这是一个类型系统和概念设计远超同类项目的 agent runtime，但其执行可靠性保证仍然停留在 "单进程、不崩溃、低并发" 的假设下。从 "能运行的原型" 到 "可信赖的内核"，关键差距不在功能缺失，而在持久化原子性和 worker 状态持久化这两个硬伤。

---

*本报告生成于 2026-04-04，基于 TurnkeyAI 仓库主分支的完整代码审查。*
