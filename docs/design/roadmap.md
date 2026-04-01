# 项目进度与路线图

> 更新日期：2026-04-01  
> 范围：当前代码库真实状态、下一阶段优先级、阶段性交付策略

## 1. 当前阶段判断

项目已经跨过“纯设计”和“核心机制补齐”阶段，当前处在 `Phase 1 / Production Hardening` 的同场景 end-to-end 验收与长期稳态验证阶段。

当前已经具备：

1. 本地 `daemon + TUI`
2. Team / Flow / Role Run 基础 runtime
3. 多模型 adapter 抽象
4. `browser / explore / finance` 三类 worker
5. Browser profile / session / target / artifact / ref 基础持久化
6. Browser Runtime v2 的 session / target 控制面
7. detached target reconnect
8. current-target resume
9. worker `spawn / send / resume / interrupt / cancel`
10. scheduled task capsule 与 re-entry 第一版
11. 受控并行的 worker / sub-session fan-out 基础能力
12. PromptAssembler / ContextBudgeter / ThreadSummary / RoleScratchpad 第一版
13. layered thread memory / journal / scratchpad / summary 持久化边界
14. structured continuation context 与 role-level continuity 第一版
15. QC / replay / API diagnosis 第一版
16. role / worker / browser / scheduled 主链 replay
17. governance surface: permission / audit / replay 查询
18. Browser Runtime v2.6 的 ownership-aware re-entry
19. replay summary / incident / grouped inspection / recovery dispatch / console / workflow-log surface
20. recovery-linked incident bundles / workflow status
21. RecoveryRun / attempt 持久化与 approve/reject/retry/fallback/resume action surface
22. browser `hot / warm / cold` resume 与 target-local snapshot/ref history
23. retrieval ranking / budget-aware packing / tool-result pruning / long-running compression 第一版
24. browser 显式 session protocol：`spawn / send / history / resume`
25. RecoveryRun event log / merged timeline / progress / phase / causality chain
26. bounded regression harness 第一版
27. recall trigger / compact-before-drop packing / `compactedSegments` metadata
28. operator summary / operator attention / replay bundle 的统一 case 语义与首页级摘要
29. browser continuity 已进入 replay / bundle / console / TUI / operator attention 视图
30. context runtime 的 approval / merge / continuation 语义 recall 与 salience compaction 强化

当前仍未具备：

1. durable execution core
2. 通用 subagent runtime v2
3. 产品级的并行 sub-agent orchestration / merge-synthesis 控制
4. 稳定的 context compiler / memory hierarchy / cache
5. tool policy / approval / trust 分层
6. 产品级长期 browser runtime
7. 完整的 replay / evaluation harness
8. Electron GUI

一句话判断：

- 运行内核：第一版已经成熟
- 当前主线：不再是补核心机制，而是验证这些机制在复杂真实链路里持续稳定

## 2. 当前规划修正

前一版规划里，我们把很多长期 kernel 能力直接放到了最前面：

1. durable execution core
2. context compiler / memory hierarchy
3. tool policy + cache

这套方向本身没有问题，但它默认了一种更“底座优先”的推进方式。

现在更合理的阶段判断是：

1. 先把当前已有 runtime 骨架往**生产优化**方向做稳
2. 再把更重的通用 kernel 能力系统化补齐

也就是说，下一阶段不再把目标写成：

- “先把最理想的 kernel 一次做完”

而是分成两期：

1. **Phase 1: Production Hardening**
2. **Phase 2: Runtime Kernel Lift**

这样更符合当前代码库的真实状态，也更符合产品化推进顺序。

## 3. 高层完成度

| 方向 | 状态 | 完成度 |
| --- | --- | --- |
| Runtime Foundation | 已完成 | 100% |
| LLM Runtime Integration | 已完成 | 100% |
| Worker Delegation Core | 已完成 | 100% |
| Browser Runtime v2 | 已完成 | 100% |
| Context / Memory Runtime v2 | 已完成 | 100% |
| QC / Replay Runtime | 已完成 | 100% |
| Desktop Product Shell | 未开始 | 0% |

如果把目标定义为“本地可跑的多角色 runtime 骨架”，当前大致在：

- `95%+`

如果把目标定义为“可日常使用的协作式 agent 工作台”，当前大致在：

- `70%`

## 4. 下一阶段的主线重排

当前最重要的不是继续堆业务链，也不是立刻把所有 kernel 一次抽齐，而是先把系统收敛成：

- **能在相同高压场景和真实日常任务里稳定工作**

因此接下来的主线分成两期。

Phase 1 的细化执行清单见：

- `docs/design/production-hardening-checklist.md`

### Phase 1：Production Hardening

第一期优先补的是已经被证明有产品价值、且能直接提升稳定性的能力：

1. Prompt / Context harness hardening
2. session / sub-session / browser continuity
3. 并行 sub-agent orchestration / fan-out / merge gate
4. tool governance 第一层
5. browser reliability 与 transport hierarchy
6. replay / audit / failure analysis 第一层

第一期的重点不是追求最强抽象，而是：

1. bounded task 能稳定跑完
2. timeout / reconnect / continue 行为可预期
3. memory / compaction / tool fallback 不容易把系统带偏
4. approval / audit / browser 使用都有清晰护栏

当前阶段判断：

- Batch 1 已完成
- Batch 2 的 Parallel Subagent Orchestration、Tool Governance、Browser ownership/re-entry、Replay/Recovery 主块已完成
- Browser session runtime 已进入显式 `spawn / send / history / resume` 形态
- bounded regression harness 与 browser reliability soak 已覆盖 browser / recovery / context / parallel / governance 主线
- Recovery runtime 已进入产品级第一版，并带 case / timeline / operator 视图
- browser continuity 已进入 replay / bundle / console / TUI / operator attention 视图
- flow / governance / replay / recovery 已有统一的 operator summary / attention / case semantics
- 当前判断：`Phase 1 / Production Hardening` 的核心机制已完成
- 下一步不进入 `Phase 2 / Runtime Kernel Lift`，而是按相同场景的 acceptance / soak / failure injection 继续验收

配套文档：

- `docs/design/phase1-productization-matrix.md`
- `docs/design/production-hardening-target-state.md`
- `docs/design/production-hardening-gap-map.md`

### Phase 2：Runtime Kernel Lift

第二期再集中推进更深的通用机制：

1. durable runtime core
2. context compiler / memory hierarchy
3. tool policy + cache taxonomy
4. work package / typed delegation
5. 全链路 replay / eval / trace

第二期的重点是把第一期已经跑稳的能力抽象成更强的内核，而不是在第一期就把所有理想模型一次上完。

## 5. Phase 1 目标与当前差距

### A. Prompt / Context Harness Hardening

当前已完成：

- PromptAssembler
- ContextBudgeter
- ThreadSummary
- RoleScratchpad
- WorkerEvidenceDigest
- capability digest 注入
- thread memory / journal / scratchpad / summary 分层持久化
- memory compaction boundaries
- role-level continuity 优先级
- recall trigger / evidence-seeking query 区分
- compact-before-drop prompt packing 与 `compactedSegments` 元数据
- pending / waiting recall 优先级增强
- unresolved summary question 的 memory carry-forward
- recent-turn salience packing

当前差距：

- retrieval / pruning / packing 已有更强第一版，但还需要持续调优
- flush / compaction policy 还有进一步产品化空间
- 长任务记忆仍缺更明确的 recall / packing 策略
- continuation packet 与 packed context 的优先级关系仍需继续收尾

下一步重点：

1. retrieval / packing / pruning 策略调优
2. long-running task compression 与 replay / recovery 对齐
3. 让 bounded task 的上下文延续继续稳定，但不再把这块作为 Phase 1 第一优先级

### B. Session / Worker / Browser Continuity

当前已完成：

- worker `spawn / send / resume / interrupt / cancel`
- scheduled task capsule 与 re-entry 第一版
- sub-session persistence 第一版
- detached target reconnect
- current-target resume
- structured continuation context
- role-level continuity 优先级
- timeout -> summarize -> continue 第一版 contract
- browser 显式 session protocol：`spawn / send / history / resume`
- browser continuity matrix：lease reclaim / wrong-owner denial / reopen/new-target 长链验证

当前差距：

- hot resume 强，continue / resume 仍需继续统一
- timeout 后 evidence-only summary 与继续执行链还需要进一步固化
- re-entry、resume、interrupt、cancel 的行为仍有边角不稳
- browser reliability 还需要更长链的 soak 验证
- target-local ref / snapshot continuity 仍需进一步稳态验证

下一步重点：

1. 并行场景下的 worker continuity 语义继续收尾
2. browser session / profile / target 的 soak 与 reliability matrix
3. 把“可续跑”能力继续做成产品级，而不是先做成最强通用抽象

### C. Parallel Subagent Orchestration

当前已完成：

- 受控并行的 worker / sub-session fan-out 基础能力
- scheduled capsule 与 re-entry hint 第一版
- browser / business-tool 路径上的多支路执行样式已有基础支撑
- shard group 持久化、retry policy、merge-back contract
- merge gate / coverage check / duplicate / conflict detection
- research shard packet / merge-synthesis packet / follow-up policy

当前差距：

- 还缺更强的 shard timeout taxonomy 和跨重启恢复演练
- 还缺 wider research UI / replay / shard inspection 视图
- 还缺更重的 typed work package，作为第二期 kernel 能力推进

下一步重点：

1. 把 shard timeout / cancel / retry taxonomy 继续补齐
2. 给 parallel orchestration 接 replay / inspection 视图
3. 在第二期里把 research shard 提升成更 typed 的 work package

### D. Tool Governance v1

当前已完成：

- capability discovery 第一版
- API diagnosis taxonomy 第一版
- transport hierarchy 偏好第一版
- tool-registry 驱动的 allowedTools / toolListSection
- permission taxonomy / cache / audit 第一版
- observational vs promotable evidence 分层
- prompt admission policy 与 unverifiable downgrade
- worker governance 已进入 prompt admission / evidence digest / audit 事件

当前差距：

- 还是 registry + permission gate，不是完整 policy engine
- transport hierarchy 还需要更强的 runtime 约束
- browser fallback / API / tool 的 trust level 还可以继续细化到更多 handler
- approval / audit 与 recovery / memory admission 的产品化面还不够完整

下一步重点：

1. official API -> business tool -> browser fallback 做成稳定主路径
2. 强化 tool retry / timeout / concurrency guard
3. 把治理模型扩展到更多 worker / browser side-effect 场景
4. 补 permission / approval / audit 的产品化 surface
5. 把 tool 层先做成“可信可控”，第二期再升格成更完整 policy kernel

### E. Browser Runtime v2.5

当前已完成：

- browser session / target / artifact / ref store
- `open / snapshot / click / type / scroll / console / screenshot`
- target-aware browser planning
- idle session eviction
- detached target reconnect
- current-target resume
- ownership-aware re-entry / lease / hot-warm-cold resume matrix
- target-local snapshot/ref history
- browser continuity matrix：lease reclaim / wrong-owner denial / reopen/new-target 长链验证

当前差距：

- browser trust integration 与长期 soak 还需要继续做实
- attach / reconnect / reopen matrix 还需要更长链验证
- idle eviction / lease / detached target 的协同行为还需继续收尾
- browser continuity 的 replay / incident 呈现还可以继续更清楚

下一步重点：

1. attach / reconnect / reopen matrix 的 soak 验证
2. browser trust integration
3. target-local snapshot/ref cache 的进一步稳定性验证
4. browser continuity 与 recovery surface 的对齐继续完善

### F. QC / Replay / Failure Analysis

当前已完成：

- step / result verifier 第一版
- replay recorder 第一版
- API diagnosis taxonomy 第一版
- 基础 recovery / fallback
- replay summary / incident / grouped inspection / recovery dispatch / console / workflow-log surface
- recovery-linked incident bundles / workflow status
- RecoveryRun / attempt 持久化与 approve/reject/retry/fallback/resume action surface
- RecoveryRun event log / merged timeline / progress / phase / causality chain
- browser-specific recovery outcome 与 repeated retry/fallback escalation policy
- recovery attempt causality / superseded relation / operator-facing progress
- bounded regression harness 与 browser reliability soak 样本
- recovery timeline / bundle / TUI 工单视图与 phase / gate 对齐

当前差距：

- 缺统一 trace/span 语义
- 缺 prompt / model / policy 对比能力
- recovery/operator surface 只剩轻量 polish
- browser reliability soak 还需要和 recovery 主链一起做更长链验证

下一步重点：

1. browser reliability 与 recovery 主链的更长链 soak / regression 样本
2. recovery action / console / workflow-log surface 的 polish
3. prompt / model / policy 对比
4. 为第二期的 trace / compiler / policy diff 打基础

## 6. 分阶段交付顺序

### Phase 1

主题：`Production Hardening`

目标：

1. 把 prompt / memory / tool / browser 这几条真实主链做稳
2. 把 bounded task 的继续执行、回放、审计、批准做成产品级体验
3. 把 browser/session/sub-session 的恢复和 ownership 做清楚
4. 让失败后的定位、继续、重试都尽量可预期

验收标准：

1. 真实日常任务可以在 bounded 范围内稳定完成
2. timeout / continue / sessions_send / re-entry 行为基本一致
3. approval / audit / browser fallback 都有清晰护栏
4. memory flush / compaction / diary/MEMORY 写入不会明显污染后续会话

### Phase 2

主题：`Runtime Kernel Lift`

目标：

1. 引入 append-only execution journal 与 durable worker envelope
2. 用 ContextCompiler 替换分散的 assembler / resolver 调用
3. 引入 memory ledger、cache taxonomy 与 tool policy kernel
4. 建立 work package / typed delegation / merge gate
5. 把 replay / eval / trace 升级成统一内核能力

概念收敛入口：

- `docs/design/task-session-runtime-model.md`
- `docs/design/task-session-runtime-mapping.md`
- `docs/design/task-session-runtime-convergence-plan.md`

该文档不要求立刻改实现，只先把后续 kernel lift 最值得收敛的三类模型定下来：

1. `TaskGraph`
2. `SessionGraph`
3. `DispatchEnvelope`

验收标准：

1. execution / context / memory / tool 行为都能用统一对象模型解释
2. 长任务、多 worker、re-entry、cache、memory admission 能协同工作
3. prompt / policy / model / compiler 改动可以稳定回放与回归
4. 系统从“产品级稳定”进一步升级为“内核级可演化”

### Phase 3

主题：`QC / Replay / Eval`

目标：

1. 建立统一 trace/span 模型
2. 扩展 replay 到 role / worker / tool / memory write
3. 建立 regression harness
4. 支持 prompt / model / policy / compiler A/B

验收标准：

1. 任一关键 run 都可按时间线重放
2. context/compiler/policy 改动可跑回归集
3. 失败能归类到固定 taxonomy，而不是散落日志

### Phase 4

主题：`Desktop Product Shell`

目标：

1. Electron shell
2. trace / replay / artifact / permission surface
3. browser session / target / approval 面板

前置条件：

1. Durable runtime 已稳定
2. Context / memory / tool policy 已形成稳定接口
3. replay / eval 已可用于定位回归

## 7. 明确暂缓事项

当前不建议优先推进：

1. Electron shell 先行
2. 单点业务链扩张
3. 大量新增 worker 类型
4. 把多 agent 做成自由群聊系统
5. 过早引入复杂多租户 / 云端架构

这些事项不是不做，而是应该排在 runtime kernel 稳定之后。

## 8. 对代码层的直接约束

接下来的设计和实现，应尽量收敛到下面这些替换点：

1. `packages/role-runtime/src/prompt-policy.ts` 从 assembler 驱动转向 compiler 驱动
2. `packages/worker-runtime/src/in-memory-worker-runtime.ts` 从 session map 升级到 durable envelope
3. `packages/team-runtime/src/context-state-maintainer.ts` 从 summary projection 扩展到 claim / digest 生产
4. `packages/qc-runtime` 从 post-hoc verifier 扩展到 trace + policy + receipt 协作
5. `packages/browser-bridge` 进一步纳入 ownership / trust / receipt 模型

## 9. 一句话结论

接下来最重要的，不是立刻把所有理想 kernel 一次做完，而是先把当前已经存在的 runtime 骨架优化到可日常使用，再在第二期把这些稳定下来的能力系统化升格为更强的 runtime kernel。
