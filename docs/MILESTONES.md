# Milestones

> 更新日期：2026-04-22

## 总览

当前项目已经完成核心 runtime 机制建设，并进入同场景 end-to-end 验收、长链 soak、failure injection 与 real-world validation 阶段。

最近一轮已经把下面这些 hardening 主线合入主干：

- W3 cross-store safety：ingress outbox、runtime-chain version/CAS、replay incident visibility
- W6 canonical schema cleanup：RelayPayload / ScheduledTaskRecord canonical shape 与 legacy fallback 收窄
- W8 browser transport sealing：relay peer identity binding、browser route validation、relay/direct-cdp smoke / soak 链路
- W10 reliability net：truth alignment、stale marker、remediation unification 与 operator/replay 可见性
- W4 storage shape：team message by-id projection、recovery run/event canonical projection 与 repair gating
- W2 worker durability：startup reconcile 可看到 unrecoverable persisted worker session
- W5 type cleanup：replay / recovery / operator / prompt / runtime support 类型边界拆细

下面的“完成”只表示对应 runtime 机制已经进主线，不表示完整桌面产品或 Phase 2 kernel 已经完成。

| Milestone | 主题 | 机制状态 | 产品化状态 |
| --- | --- | --- | --- |
| A | Runtime Foundation | 已完成 | 稳定维护 |
| B | LLM Runtime Integration | 已完成 | 稳定维护 |
| C | Worker Delegation Core | 已完成 | 长链 / 并行验收继续 |
| D | Browser Runtime v2 | 已完成 | bridge / relay / direct-cdp 长链 soak 继续 |
| E | Context / Memory Runtime v2 | 已完成 | 高压预算与真实任务验收继续 |
| F | QC / Replay Runtime | 已完成 | recovery / operator 可读性收尾 |
| G | Desktop Product Shell | 未开始 | 未开始 |

## 分期策略

下一阶段不再按“先把所有理想 kernel 一次做完”来排优先级，而是明确分成两期：

### Phase 1: Production Hardening

机制主线已经完成，剩余优先级转为验收与收口：

1. browser bridge / relay / direct-cdp 长链真实任务验证
2. recovery / replay / operator case 状态一致性和可读性收尾
3. context / memory / compaction 在高压预算和真实任务下继续调优
4. parallel orchestration / governance / permission / audit 的 contract 和 regression 扩充
5. real-world acceptance、failure injection、transport soak 持续扩样本

当前进度：

- `Phase 1 / Production Hardening` 的核心机制已完成
- W3 / W6 / W8 / W10 / W4 / W2 / W5 系列 hardening 已合入主线
- runtime hard-points parity 的五个 pack 已全部进主干
- `Runtime Observability v1.x` 已覆盖 flow / replay / recovery / live role/worker/browser
- bounded regression、browser soak、runtime/operator acceptance 已覆盖 browser / recovery / context / parallel / governance / runtime 主线
- validation-ops 已能汇总 Phase 1 readiness gates：phase1-e2e profile、release-readiness、relay/direct-cdp transport soak、acceptance/realworld/soak series
- 当前判断：进入同场景 end-to-end 验收、failure injection 和 real-world validation，不直接切入 `Phase 2`

### Phase 2: Runtime Kernel Lift

再做：

1. durable execution journal / worker envelope
2. context compiler / memory hierarchy / cache taxonomy
3. tool policy kernel
4. typed delegation / work package / merge gate
5. 更完整的 trace / eval / regression

## A. Runtime Foundation

状态：已完成

已完成：

- monorepo 和 package 分层
- file-backed store
- Team / Flow / Role Run 基础 runtime
- daemon
- TUI
- `user -> lead -> member -> lead` 最小闭环

## B. LLM Runtime Integration

状态：已完成

已完成：

- model catalog
- adapter registry
- OpenAI-compatible
- Anthropic-compatible
- heuristic fallback
- role profile / prompt policy / response generator

## C. Worker Delegation Core

状态：已完成

已完成：

- WorkerRuntime contract
- worker session state
- `spawn / send / resume / interrupt / cancel`
- `browser / explore / finance` 三类 worker
- preferred worker routing
- capability discovery 第一版
- scheduled task capsule 第一版
- structured continuation context
- scheduled / role / worker re-entry contract 第一版
- 受控并行的 worker / sub-session fan-out 基础能力
- fan-out / fan-in / merge-synthesis 的统一 envelope
- merge gate / coverage check / duplicate / conflict detection
- research shard packet / merge-synthesis packet / follow-up policy
- scheduled / worker / browser continuity 已和并行 envelope 对齐
- browser worker 已切到显式 browser session protocol：`spawn / send / history / resume`

下一步：

- 并行/worker 长链样本继续扩大
- 同场景 acceptance 与 failure injection 继续补齐
- durable worker envelope 作为第二期能力推进

## D. Browser Runtime v2

状态：已完成

已完成：

- browser profile / session / target / artifact / ref store
- `open / snapshot / click / type / scroll / console / screenshot`
- target-aware browser planning
- session / target 控制面
- detached target reconnect
- idle session eviction
- current-target resume
- ownership model / lease / hot-warm-cold resume matrix
- ownership-aware scheduled re-entry
- target-local snapshot/ref history
- detached-target invalid-resume / stale-session failure taxonomy 对齐
- browser continuity matrix：lease reclaim / wrong-owner denial / reopen/new-target 长链验证
- multi-target continuity 与 detached+lease-reclaim 组合 soak
- browser continuity 已进入 replay / bundle / console / operator summary / attention

下一步：

- relay / direct-cdp bridge 在真实任务里的长链验证继续扩大
- reconnect / eviction / reclaim / owner mismatch 的组合 soak 继续累计
- target-local snapshot / ref history 与 artifact continuity 的长期稳定性继续验证

## E. Context / Memory Runtime v2

状态：已完成

已完成：

- PromptAssembler
- ContextBudgeter
- ThreadSummary
- RoleScratchpad
- ThreadMemory / ThreadJournal
- WorkerEvidenceDigest
- capability digest 注入
- memory compaction boundaries
- role-level continuity 优先级
- retrieval ranking / recall trigger / budget-aware packing / tool result pruning
- long-running task compression 第一版
- compact-before-drop prompt packing 与 `compactedSegments` 元数据
- pending / waiting recall 优先级增强
- unresolved summary question 的 memory carry-forward
- recent-turn salience packing
- approval / merge / continuation 的语义 recall 与 ranking 强化
- older salient user/assistant turns 的 compaction 保留规则
- unresolved merge / approval 语言进入 summary / scratchpad / memory recall

下一步：

- context 的 real-world long-chain 验收继续扩大
- session memory / compact 的真实任务表现继续验证
- ContextCompiler 与 memory ledger 作为第二期主线

## F. QC / Replay Runtime

状态：已完成

已完成：

- step/result verifier 第一版
- API diagnosis taxonomy 第一版
- replay recorder 第一版
- role / worker / browser / scheduled 主链 replay
- governance surface: permission / audit / replay 查询
- replay summary / incident / grouped inspection / recovery dispatch / console / workflow-log surface
- recovery-linked incident bundles / recovery workflow state
- RecoveryRun / attempt 持久化与 approve/reject/retry/fallback/resume action surface
- recovery workflow 的 grouped follow-up / bundle linkage
- 恢复工单化视图：run / timeline / bundle / progress / phase
- recovery event log / attempt supersede / causality chain
- repeated retry / fallback 的策略升级与 browser-specific recovery outcome
- bounded regression harness 与 browser reliability soak 样本扩充
- 基础 recovery / fallback
- recovery timeline / bundle / TUI 工单视图与 phase/gate 对齐
- operator summary / operator attention / replay bundle 的统一 case state / severity / lifecycle
- active/resolved recent case cards 与 latest update / next step 摘要

下一步：

- browser / recovery / runtime 的 real-world validation 继续扩大
- recovery / replay / operator surface 的 case state、gate、next action 术语继续统一
- operator/runtime 主入口的长期值班易用性继续打磨
- prompt / model / policy 对比与 compiler 级工作放到第二期

## G. Desktop Product Shell

状态：未开始

计划：

- Electron shell
- team/chat 界面
- trace / replay 面板
- browser session 面板
- permission / screenshot / artifact surface

## 下一阶段重点

当前不建议直接进入桌面壳，也不建议立刻切 Phase 2 kernel，而建议继续推进下面几条验证主轴：

1. Browser bridge / relay / direct-cdp 长链真实任务验证
2. Recovery / replay / operator case 语义收口
3. Context Runtime 高压预算与真实任务验证
4. Parallel orchestration / governance contract regression 扩充
5. Failure injection / real-world acceptance / transport soak 扩样本

配套文档：

- `docs/design/phase1-productization-matrix.md`
- `docs/design/production-hardening-target-state.md`
- `docs/design/production-hardening-gap-map.md`

对应到 Phase 1 收尾的优先顺序：

1. Browser bridge / relay / direct-cdp
2. Recovery / replay / operator surface
3. Context / memory / compaction
4. Parallel orchestration / governance
5. Regression / soak / failure injection

先把这些生产优化主线在真实长链里做稳，再推进更重的 kernel 化；GUI 和业务层挂载应放在 runtime/workbench backend 稳态之后。
