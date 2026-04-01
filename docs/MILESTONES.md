# Milestones

> 更新日期：2026-04-01

## 总览

当前项目已经完成核心 runtime 机制建设，并进入同场景 end-to-end 验收与长期稳态验证阶段。

| Milestone | 主题 | 状态 | 完成度 |
| --- | --- | --- | --- |
| A | Runtime Foundation | 已完成 | 100% |
| B | LLM Runtime Integration | 已完成 | 100% |
| C | Worker Delegation Core | 已完成 | 100% |
| D | Browser Runtime v2 | 已完成 | 100% |
| E | Context / Memory Runtime v2 | 已完成 | 100% |
| F | QC / Replay Runtime | 已完成 | 100% |
| G | Desktop Product Shell | 未开始 | 0% |

## 分期策略

下一阶段不再按“先把所有理想 kernel 一次做完”来排优先级，而是明确分成两期：

### Phase 1: Production Hardening

优先做：

1. prompt / memory / compaction 稳定化
2. sub-session / continue / re-entry / timeout summarize
3. tool registry / permission / audit / transport hierarchy
4. browser session / target / ownership / reconnect
5. replay / failure analysis 第一层产品化

当前进度：

- `Phase 1 / Production Hardening` 的核心机制已完成
- runtime hard-points parity 的五个 pack 已全部进主干
- `Runtime Observability v1.x` 已覆盖 flow / replay / recovery / live role/worker/browser
- bounded regression、browser soak、runtime/operator acceptance 已覆盖 browser / recovery / context / parallel / governance / runtime 主线
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

- 更长链的 real-world browser soak 继续扩大样本
- reconnect / eviction / reclaim 的真实任务验证继续累计
- target-local snapshot / ref history 的长期稳定性继续验证

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

当前不建议直接进入桌面壳，而建议继续推进下面几条验证主轴：

1. 同场景 end-to-end 验收
2. Browser Runtime 长链 soak
3. Context Runtime 真实任务验证
4. Failure injection / regression 扩充
5. 保持 recovery / browser / context / runtime 四条主线稳态

配套文档：

- `docs/design/phase1-productization-matrix.md`
- `docs/design/production-hardening-target-state.md`
- `docs/design/production-hardening-gap-map.md`

对应到 Phase 1 的优先顺序：

1. Prompt / Context Harness Hardening
2. Session / Worker / Browser Continuity
3. Parallel Subagent Orchestration
4. Tool Governance v1
5. Browser Runtime 稳定化
6. QC / Replay / Failure Analysis

先把这些生产优化主线做稳，再推进更重的 kernel 化，GUI 和业务层挂载都会顺很多。
