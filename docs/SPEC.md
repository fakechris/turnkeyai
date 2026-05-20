# TurnkeyAI Spec — Personas, Capabilities, User Stories

> 更新日期：2026-05-20
> 范围：当前 `main` 真实可用的能力面 + 已经写进 README/MILESTONES 但仍在验收的能力面 + 明确的非目标
> 与 `docs/VISION.md` / `docs/MILESTONES.md` 的关系：Vision 讲为什么、Milestones 讲什么时候、本文档讲谁、用什么、做完什么算可用
> 产品入口方向：`docs/design/mission-control-product-design.md` 定义下一阶段用户端产品叙事。TurnkeyAI 的用户入口应收敛为 Mission Control：多 agent 围绕用户任务协同，browser bridge 只是 context/tool surface 之一。

## 1. Personas

本项目当前面向 4 类用户。前 3 类是已支持的；第 4 类是未来目标，仍是非目标。

### 1.1 Runtime 开发者（项目自己）

- 在仓库内开发 runtime / store / transport
- 通过 `npm run daemon` + `npm run tui` 跑本地完整闭环
- 通过 `phase1-readiness` / `phase1-baseline` / `transport-soak` 做退出验证
- 主要工具：TUI 70+ 命令、daemon HTTP 接口、replay/inspect/recovery 入口

### 1.2 Operator / 排障值班

- 已经有一个长链任务在跑（或刚跑挂了）
- 不读源码，凭 TUI 入口判断"卡在哪、能不能继续、需不需要人工"
- 主要工具：`operator-summary` / `operator-attention` / `operator-triage` / `replay-console` / `recovery-*`

### 1.3 外部 agent（Claude Code / 其他 LLM agent）

- 通过 `~/.turnkeyai/skills/` 自动生成的 skill 文档发现 daemon
- 通过 daemon HTTP `bridge/*` 把浏览器当工具用
- 不感知 daemon 内部的 team/role/worker 分层；只面对一组稳定的 `command / advanced / expert / batch` 工具

### 1.4 桌面终端用户（**当前阶段非目标**）

- 期望：通过 Electron GUI 完成日常协作
- 现状：未开始（README 与 VISION 都明确这一点）
- 不应为这类用户提前冻结对外契约

## 2. Capability Map

按已实现的能力面分类。每一项后面括号给出当前主入口位置。

### 2.1 Team coordination
- Team thread 创建 / 查询（`bootstrap`, `threads`, `messages`）
- `user -> lead -> member -> lead` 最小闭环（CoordinationEngine）
- Lead role 收敛与 handoff 规划（HandoffPlanner）
- 并行 fan-out / fan-in / merge-synthesis（受控的 shard-group / merge-gate）

### 2.2 Role runtime
- Prompt 组装（PromptAssembler）
- 模型选择（model catalog / model chain，`modelRef` / `modelChain` 引用）
- 上下文预算与裁切（ContextBudgeter，compact-before-drop）
- 多分层记忆（thread summary / journal / scratchpad / session memory / worker evidence）
- Pending / waiting / decision carry-forward
- Provider-native tool-use loop（Anthropic-compatible / OpenAI-compatible tools）
- Tool call / progress / result message-native persistence 与 Mission timeline replay

### 2.3 Worker runtime
- `spawn / send / resume / interrupt / cancel`
- `browser / explore / finance` 三类 worker handler
- Worker session 持久化 + daemon 重启 hydrate
- Capability discovery 与 preferred-worker 路由

### 2.4 Browser runtime
- Session / target / profile / artifact / ref 持久化
- `open / snapshot / click / type / scroll / console / screenshot`
- Ownership / lease（claim / release / expire / reclaim）
- `hot / warm / cold` resume
- `attach / reconnect / reopen / new_target` 决策
- Target-local snapshot / ref history
- 三种 transport：local / relay / direct-cdp

### 2.5 Bridge surface（外部 agent 用）
- `GET /bridge/status`
- `POST /bridge/command`（Tier 1，ambient session）
- `POST /bridge/advanced`（Tier 2：hover / pdf / find_tab / network.* 等）
- `POST /bridge/expert`（Tier 3：原始 CDP 直通；仅 direct-cdp）
- `POST /bridge/batch`

### 2.6 Replay / recovery / operator
- Replay summary / incident / grouped inspection / console
- Recovery run / attempt / event log / merged timeline / phase / gate
- `approve / reject / retry / fallback / resume` action surface
- Operator summary / attention / triage 首页级摘要
- 案件语义（case state / severity / lifecycle / case key）

### 2.7 Governance / trust
- Permission cache + trust grading + prompt admission 三层 gate
- Capability discovery 先于 worker 派遣
- Transport hierarchy（official API → business tool → browser fallback）
- Audit / governance 查询

### 2.8 Validation / soak / regression
- bounded regression harness
- failure injection suite
- transport soak（relay / direct-cdp）
- realworld runbook
- scenario-parity acceptance
- `phase1-readiness` / `phase1-baseline`
- `validation-ops` 把上面所有结果聚成 operator-facing 读数

## 3. User Stories

每条 story 包含：**前置条件 / 行为 / 验收 / 失败语义 / 当前状态**。

### 3.1 Team coordination

#### US-T1 — 用户向 team thread 发消息，lead 收敛回复

- 前置：一个已 bootstrap 的 team thread
- 行为：用户 POST `/messages` → CoordinationEngine 持久化消息 → 派发到 lead role → lead 可在内部 handoff 给 member → 收敛回 lead 给用户
- 验收：thread message timeline 是单调的，最终一条来自 lead；flow ledger 记录每次 handoff；runtime chain 可重放
- 失败语义：handoff 死循环必须被 anti-loop 拦截；lead 不可达走 lead fallback；任一 store 写入失败需在 replay/recovery 中可见
- 状态：✅ 主链已稳

#### US-T2 — 失败的 role run 形成 recovery case 并被推进

- 前置：US-T1 中某个 role run 已失败或卡住
- 行为：进入 RecoveryRun → 由 operator 选 `retry / fallback / approve / reject / resume / inspect` → 完成或落到 `manual_follow_up`
- 验收：一条失败主链对应一个 recovery run（不是每个 attempt 一个 run）；TUI `recovery-run <id>` 能显示 phase / gate / allowed actions / next step
- 失败语义：自动恢复只在 `retryable` 桶里发生；其他桶强制进 `manual_follow_up`；recovery 自身失败也被记录
- 状态：✅ 主链已稳，operator 文案仍在收尾

#### US-T3 — 受控并行 fan-out / merge

- 前置：lead role 计划 fan-out 多个 worker / sub-role
- 行为：shard group 派发 → 每个 shard 独立执行 → merge gate 检查 coverage / duplicate / conflict → 通过则 merge-synthesis；失败则 follow-up
- 验收：merge gate 失败时 partial 结果不会被当成 final；timeout shard 经 retry 可重入 merge
- 状态：✅ 已落基础能力；长链 soak 仍在补样本

### 3.2 Role runtime

#### US-R1 — Role 按 prompt policy 调用模型

- 前置：Role 有 `modelRef` 或 `modelChain`
- 行为：PromptAssembler 组装 → ContextBudgeter 按预算裁切 → adapter 调用 → response generator 返回
- 验收：prompt 体积受 RequestEnvelopeGuard 控制；超预算时按 `compact-before-drop` 渐进降级而不是直接 fail
- 失败语义：超预算后所有降级仍失败 → `RequestEnvelopeOverflowError`；adapter 异常 → fallback chain
- 状态：✅ 已稳；ContextCompiler v2 是 Phase 2 目标

#### US-R2 — Re-entry / continuation 保住 pending 与 unresolved question

- 前置：之前的 role 执行被中断（timeout、interrupt、daemon 重启）
- 行为：continuation packet 携带 pending work / open question / decision-or-constraint 重新进入 prompt
- 验收：`prompt-console` 能显示打包数量与 carry-forward 项；高压预算下 pending 不被弱信号挤出
- 状态：✅ 第一版已稳；高压真实任务下的稳定性仍是 Phase 1 收尾重点

#### US-R3 — Role 使用原生 tool-use 协议完成子任务

- 前置：LLM provider 支持 tool schema；daemon 已配置 executable worker handlers
- 行为：role runtime 把可执行能力注册成 provider-native tools → 模型返回 `tool_call` / `tool_use` → runtime 执行工具 → 写入 assistant tool call、tool progress、role=tool result → 再进入下一轮模型生成
- 验收：TeamMessageStore 中 tool call / progress / result 是结构化字段，不靠纯文本约定；`/message/cancel-tools` 能取消进行中的工具；Mission Detail timeline 能 replay `tool call → tool progress → tool result → final answer`
- 失败语义：不可执行 worker 不进入 capability registry；工具失败写成 `isError=true` 的 tool result；side-effectful 工具走 permission query/result/applied 回路
- 状态：✅ 主线已稳；已有 mission-route 级闭环测试覆盖用户入口到 timeline replay

### 3.3 Worker runtime

#### US-W1 — Role 派生 worker 完成子任务

- 前置：Role 决定派遣 `browser` / `explore` / `finance` 中的一种
- 行为：`spawn` → handler 选 transport / API → 执行 → 返回 evidence / artifact / continuation
- 验收：worker session 可被 TUI `runtime-worker-sessions` 看见；失败计入 worker durability summary

#### US-W2 — Daemon 重启后运行中的 worker session 被 hydrate

- 前置：worker session 处于 `running` 时 daemon 被掐
- 行为：startup hydrateSessions → 把 session 状态降级为 `resumable` 并附 continuation digest
- 验收：startup reconcile summary 能列出被恢复 / 不可恢复的 session；不可恢复的进入 operator attention
- 失败语义：handler 不再可用 → 标 `unrecoverable`，不静默丢
- 状态：✅ 已落（注意：这是 *resumable*，不是 checkpoint-accurate durable execution，文档要求别误读）

### 3.4 Browser runtime

#### US-B1 — 长任务里同一 thread 的 browser continuity 可预测

- 前置：role 已经 `spawn` 过一个 browser session 并工作过几轮
- 行为：再次进入时，ownership-aware re-entry 决策走 `hot / warm / cold` resume
- 验收：同一 continuity 不会跳错 target；wrong-owner / expired-lease / detached-target 不会静默复活旧 session
- 失败语义：所有失败落入统一 failure taxonomy（`stale_session / detached_target / invalid_resume / wrong_owner / transport_error`），不是散字符串
- 状态：✅ 机制已稳；长链 soak 仍在跑

#### US-B2 — 外部 agent 通过 bridge 把浏览器当工具用

- 前置：daemon 已启动；relay 扩展或 direct-cdp 已就绪
- 行为：外部 agent → `POST /bridge/command` 或 `/bridge/advanced` 或 `/bridge/expert` → ambient session 自动管理
- 验收：成功返回 artifact / snapshot ref；失败返回明确 error bucket；`bridge/status` 能显示 transport / relay / expert 可用性
- 状态：✅ 已落；raw CDP expert lane 已有 runbook

#### US-B3 — Transport 重连有统一契约

- 前置：网络抖动 / 浏览器重启 / extension 重启
- 行为：当前 transport adapter 提供 `reconnect()` 或等价能力 → 验证 ownership → 重新挂回原 target / 给出降级
- 验收：所有 adapter 在同一接口位置暴露 reconnect / ownership 验证；reconnect 决策可在 replay 里看见
- 状态：🟡 部分完成。需要分三层看：
  - **(1) 接口级 transport 契约**：✅ `BrowserTransportAdapter.inspectSessionOwnership / getTransportHealth / reconnect` 已在三种 transport（local / relay / direct-cdp）实现。
  - **(2) Payload-derived reconnect visibility（限定范围）**：✅ 但只覆盖了 browser-runtime *自己*识别为 reconnect 的那一条 outcome。具体：
    - `BrowserTaskResult.targetResolution === "reconnect"` → outcome 解析为 `detached_target_recovered`（"通过 reconnect 把 detached 的 target 恢复回来"）。
    - browser continuity payload 里的 `browserDiagnosticBucket === "reconnect_required"` → 在 replay incident 里出 `reconnect_session` remediation 建议。
    - 注意 **不包括** `attach`（被解析为 `hot_reuse`）和 `reopen` / `new_target` / cold resume（被解析为 `cold_reopen`）。这些是合法的连接形态但不是 reconnect 语义；不要把它们也算进"reconnect 已经在 bundle 里"的范围。
  - **(3) Adapter-level reconnect event visibility**：⚠️ 尚未有任何 daemon 生产路径调用 `adapter.reconnect()` —— P0.3 落下的 contract 目前只在 transport-contract 测试里被调用。即便未来加上调用者，`BrowserTransportReconnectResult` 和 `getTransportHealth()` snapshot 也没有接入 replay recorder / operator bundle。要让 daemon 主动 reconnect 能在 operator case / replay bundle 里看见，需要先：(i) 在合理的恢复路径上调用 `adapter.reconnect()`；(ii) 让 transport 在 reconnect/health 状态变化时 emit replay 事件并接入 bundle。归到 W10 truth-alignment 后续推进。

### 3.5 Replay / recovery / operator

#### US-Q1 — 任意失败链都能被还原为可读 case

- 前置：主链失败
- 行为：replay summary 聚合 → recovery run 绑定 → bundle 给出 gate / allowed actions / next step / latest outcome
- 验收：operator 不翻源码即可判断当前 phase 和下一步
- 状态：✅ 主线已稳

#### US-Q2 — Operator 在 TUI 单页可定位排障入口

- 前置：值班开始，可能多个 case 同时存在
- 行为：`operator-triage` 单页给出最高优 incident / runtime waiting / prompt pressure 与对应 console 命令
- 验收：从 `operator-triage` 出发，3 跳内能到具体 case 详情
- 状态：✅ 已落

#### US-Q3 — Validation harness 给出 north-star closed-loop rate

- 前置：CI 或值班需要一个客观数字
- 行为：`phase1-readiness` 跑完 phase1-e2e profile + transport soak + release-readiness + acceptance/realworld/soak series → 写入 `validation-ops` readiness gates
- 验收：closed-loop rate = (completed + actionable) / total；silent_failure / ambiguous_failure 必须为 0
- 状态：✅ 已落；当前 Phase 1 退出的客观闸口就靠它

### 3.6 Governance

#### US-G1 — 工具调用受三层 gate

- 前置：role/worker 准备调用 official API / business tool / browser
- 行为：capability discovery → permission cache → trust grading → prompt admission
- 验收：被拒绝的调用进入 recovery / operator 视图，不静默 drop
- 状态：✅ 主线已稳；prompt 注入防御与 evidence 信任面是 Phase 2 主线

#### US-G2 — Fallback hierarchy 显式可解释

- 前置：official API 失败或未授权
- 行为：按 transport hierarchy 自动降到 business tool 或 browser
- 验收：fallback 决策在 replay / governance 查询中可看见
- 状态：✅ 已落

## 4. Cross-cutting Invariants

下面 5 条是当前系统**承诺要守住**的不变量。任何一条被破坏都属于 P0 bug。

| Invariant | 说明 | 当前守护机制 | 已知缺口 |
|---|---|---|---|
| **I1. 写入原子性** | message + flow 在同一 outbox claim 里推进；runtime-chain 是 best-effort 投影，crash 后由 reconcile 收敛——operator 视图不应该看到比真实世界更乐观的状态 | FileBatchOutbox（message + flow）+ TeamMessageStore.appendIfAbsent + expectedVersion（flow / role-run / runtime-chain / recovery / scheduled）+ runtime-chain startup reconcile | runtime-chain 仍是 best-effort（recordFlowCreated 等用 `recordRuntimeChainBestEffort` 包裹）；真正跨 store 的事务边界要等 Phase 2 |
| **I2. Worker session 真相** | 重启后 worker 状态要么 hydrate 为 resumable，要么标 unrecoverable，不能"看起来在跑但实际丢了" | WorkerSessionStore + hydrateSessions + startup reconcile | 当前还不是 checkpoint-accurate execution，不能宣称"零丢失" |
| **I3. Browser ownership** | 同一 browser session 同一时间只有一个 owner；非 owner 不能改 target 状态 | Lease + ownership-aware re-entry | 内部直调可绕过 daemon 层检查（review 已标记，待 transport contract 收紧后再补） |
| **I4. Truth vs runtime 对齐** | 任何 replay / operator 视图都必须能在 stale 时被识别并提示 reconcile | truth-alignment + stale marker + remediation unification | "暴露 drift"已做，"自动修复闭环"还没 |
| **I5. Tool admission** | 外部 evidence（尤其 browser textExcerpt）进入 prompt 前必须经过 admission gate | prompt admission + evidence trust policy | 反 prompt-injection 防御仍偏弱，Phase 2 加强 |

## 5. Non-goals（当前阶段明确不做）

1. Electron 桌面 shell 与对应业务 UI
2. 多节点 / 跨机器 daemon 集群
3. 通用 subagent runtime v2 / durable execution kernel
4. 任意插件系统（worker / role / transport 都仍是有限 union）
5. 多租户 / 远端服务化
6. 任何"自动恢复任意失败"的承诺（明确只在 `retryable` 桶内自动恢复）

## 6. Acceptance — Phase 1 整体退出条件

只有同时满足，才能宣布 Phase 1 完成：

1. browser continuity 在长链任务下基本可预测（covered by transport-soak + realworld）
2. recovery case 能稳定推进到 `recovered / aborted / manual_follow_up` 之一（covered by phase1-e2e profile）
3. context 在高压预算下不漂（covered by acceptance + prompt-console 计数）
4. parallel / governance / operator 不再是主链弱点
5. regression / soak 套件覆盖主链且持续绿
6. north-star closed-loop rate ≥ 1.0；silent/ambiguous failure = 0（covered by `phase1-readiness` + `phase1-baseline`）

且**同时**架构层面：

7. message + flow 写入处于同一 outbox claim 信封内（**P0.1 完成**）；runtime-chain 写入仍是 best-effort 投影，crash 后由 replay/reconcile 路径推进收敛——非真正的 cross-store 事务边界。真正的 cross-store transaction 仍是 Phase 2 目标。
8. message store 提供与"append-only create-if-not-exists"等价的幂等保护（`appendIfAbsent` 关闭了 outbox 重投递的 check-then-act 竞态以及静默 threadId 覆盖）（**P0.2 完成**）。其他 store 的 `expectedVersion`-style update CAS 在 message store 上目前没有对应位（因为消息天然 append-only，无 update 路径）。
9. browser transport reconnect / ownership 是一等接口契约（**P0.3 完成**）。Replay/operator 中的 reconnect 可见性需要分三层判断：(a) 接口契约 ✅；(b) 限定的 payload-derived 可见性（仅 `targetResolution === "reconnect"` 这条 detached-target-recovered 路径，以及 continuity 里的 `reconnect_required` 桶）✅；(c) adapter-level reconnect 事件可见性（含尚不存在的 daemon 主动调用路径）⚠️ 仍未做，归 W10 truth-alignment 后续。详见 §3.4 US-B3 的拆分说明，特别注意 attach / reopen / cold resume 不在 (b) 的覆盖范围内。

满足这 9 条后才允许进入 Phase 2 kernel lift。
