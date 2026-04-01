# Production Hardening Checklist

> 更新日期：2026-03-31
> 目标：把 `Phase 1: Production Hardening` 从方向性描述收敛成可执行清单，明确先做什么、每项依赖什么、做到什么算完成。

## 1. 这份清单解决什么问题

现在项目已经不是“链路能不能跑通”的问题，而是“真实日常任务能不能稳定跑完”的问题。

所以这份清单不追求最重的 kernel 抽象，而是优先解决下面 6 类生产问题：

1. prompt / memory / compaction 漂移
2. sub-session / continue / re-entry 行为不统一
3. 并行 fan-out 后没有稳定 merge 语义
4. tool 调用仍偏 capability 层，不够治理化
5. browser session / ownership / reconnect 还不够产品级
6. replay / failure analysis 还需要收成更稳定的 recovery runtime

当前阶段判断：

- 这 6 条主线的核心机制已经基本具备
- 后续工作的重点不再是补全“有没有”，而是做模块级、case 级、operator 级的产品化校准
- 当前已经进入最后收尾：更长链 soak、bounded regression 扩充、operator-facing polish、context discipline 最后一轮调优
- 配套矩阵见：`docs/design/phase1-productization-matrix.md`

---

## 2. Phase 1 目标

Phase 1 的验收目标只有一句话：

> bounded 的真实任务可以稳定完成，并且 continue / reconnect / replay / audit 行为可预期。

更具体一点，意味着：

1. 任务不会因为上下文轻微膨胀就明显漂移
2. 中断后可以继续，而不是重开新任务
3. 多支路 worker 并行后，主控能有规则地汇总
4. tool fallback、permission、audit 不会互相打架
5. browser 登录态和 target/session 不会轻易乱掉
6. 失败后有足够 trace 支撑诊断与重试

---

## 3. 总体顺序

建议按下面顺序推进，不要并行摊太开：

1. Prompt / Context Harness Hardening
2. Session / Worker / Browser Continuity
3. Parallel Subagent Orchestration
4. Tool Governance v1
5. Browser Runtime v2.5
6. QC / Replay / Failure Analysis

原因很简单：

- 1 和 2 不稳，后面的 orchestration 和治理都会漂
- 3 不稳，wide-search / fan-out 型任务无法产品化
- 4 不稳，系统对外部世界的调用会不可信
- 5 不稳，browser 仍然是最容易把系统拖垮的一环
- 6 要建立在前面主链已相对稳定之上

---

## 4. Workstream A: Prompt / Context Harness Hardening

### A1. Prompt assembly 顺序稳定化

目标：

- 固定 bootstrap / role policy / tool list / memory / task packet 的装配顺序
- 把当前“能拼出来”升级成“顺序稳定且可观察”

任务：

1. 固定 prompt section priority
2. 给每段 section 打 source tag
3. 记录 render fingerprint
4. 给 omitted/truncated sections 留可诊断元数据

完成标准：

- 同样输入不会因 section 顺序漂移而生成不同 prompt 结构
- debug/replay 时能看见每段 prompt 的来源和裁剪原因

### A2. Memory file discipline

目标：

- 把 `MEMORY.md` / diary / summary / scratchpad 的职责彻底区分清楚

任务：

1. 明确长期偏好、临时决策、运行期摘要的写入规则
2. 把 flush / compaction 与 file memory 更新时机固定下来
3. 防止 diary / scratchpad 污染长期记忆

完成标准：

- 长期信息不会被临时信息冲掉
- 临时信息能跨 bounded 任务继续，但不会永久污染

### A3. Context budgeting and pruning

目标：

- 让 budgeting 从“粗糙裁切”升级为“可预测裁切”

任务：

1. section-level budget policy
2. tool-result pruning policy
3. worker evidence digest 缩减规则
4. hard-required / sticky / optional 的优先级规则

完成标准：

- token 紧张时，系统能稳定裁掉低优先级内容
- bounded 任务不会因随机裁切而失去关键上下文

---

## 5. Workstream B: Session / Worker / Browser Continuity

### B1. Continue / retry / resume 语义统一

目标：

- 把 `continue`、`resume`、`retry`、`sessions_send` 的行为明确化

任务：

1. 统一 worker session state transition
2. 区分“接着跑”“重新跑”“失败后补跑”
3. 明确 scheduled re-entry 恢复时读取哪些 state

完成标准：

- 同一类恢复请求总是落到同一类行为
- 不会出现“看起来是继续，实际上是新开”的隐藏分叉

### B2. Timeout summarize -> continue

目标：

- 任务超时后，能先收束成 evidence-only summary，再安全继续

任务：

1. timeout summarization contract
2. summarize 后的 resume packet
3. timeout 后的 partial result 标准化

完成标准：

- 超时不会直接把任务打断成不可恢复状态
- 用户能明确区分 partial 和 final

### B3. Re-entry stability

目标：

- scheduled task、user follow-up、worker resume 回到同一执行上下文

任务：

1. role run / worker run / browser session 的 re-entry 绑定
2. resume hint 的统一结构
3. browser target/session 续跑一致性

完成标准：

- re-entry 后不会轻易丢失当前 worker / browser 状态

---

## 6. Workstream C: Parallel Subagent Orchestration

状态：

- 已完成

### C1. Fan-out envelope

目标：

- 把“并行开多个 sub-session”从 planner 技巧升级成 runtime contract

任务：

1. parent-run 下的 task shard 定义
2. sub-session group identity
3. parallel child runs 的 timeout / cancel / retry policy

完成标准：

- 并行子任务不再只是若干松散 worker，而是一个可追踪的 group
- 已落地：fan-out shard group 会持久化到 flow ledger，并带 retry / merge-back 元数据

### C2. Merge gate and coverage check

目标：

- 主控汇总前先检查覆盖率和缺失项

任务：

1. completeness gate
2. coverage check
3. duplicate / conflict detection
4. merge 前 follow-up policy

完成标准：

- fan-out 后不会直接把 partial 结果当 final
- 缺漏和冲突能进入 follow-up，而不是静默吞掉
- 已落地：merge gate 会产出 coverage / duplicate / conflict 信息，并把 partial merge 标成 follow-up required

### C3. Wide-search style orchestration

目标：

- 让并行研究型任务成为显式能力，而不是隐式 planner 偏好

任务：

1. 定义 research shard packet
2. 定义 merge-synthesis packet
3. 定义 partial / missing / conflicting result 处理策略

完成标准：

- 多支路研究任务可以稳定拆分、并行、汇总
- 已落地：research shard packet / merge-synthesis packet 已进入 runtime envelope 与 prompt packet

---

## 7. Workstream D: Tool Governance v1

### D1. Transport hierarchy 稳定化

目标：

- 明确 `official API -> business tool -> browser fallback` 的主路径

任务：

1. transport preference policy
2. runtime fallback guard
3. trust downgrade 规则

完成标准：

- 同类任务会优先走更可信、更便宜的执行层

### D2. Permission / audit / approval

目标：

- 让 side-effectful tool 调用具备一致的治理行为

任务：

1. approval requirement taxonomy
2. audit event 模型
3. permission cache 与 retry 行为

完成标准：

- 有状态/写入型调用能被审计、批准、回看

当前状态：

- 已完成第一版：
  - approval requirement taxonomy
  - permission cache
  - permission denial 后 retry / fallback policy
  - audit event payload 与 worker governance 接线

### D3. Observational vs promotable evidence

目标：

- 区分哪些 tool 结果能进入后续 prompt，哪些只能留作观察证据

任务：

1. evidence trust grading
2. prompt admission policy
3. unverifiable result downgrade

完成标准：

- 外部不可信结果不会直接污染后续推理

当前状态：

- 已完成第一版：
  - browser / API / tool evidence trust grading
  - prompt admission policy
  - unverifiable result downgrade
  - worker evidence digest / memory retrieval / prompt assembly 的 admission 过滤

---

## 8. Workstream E: Browser Runtime v2.5

### E1. Ownership and login-state policy

目标：

- 明确 browser profile / session / target 归属

任务：

1. profile ownership policy
2. session lease policy
3. login-state persistence boundary

完成标准：

- resume / reconnect 不会错误复用不该复用的登录态

### E2. Resume matrix

目标：

- 把 hot / warm / cold resume 做成显式策略

任务：

1. resume policy matrix
2. attach / reconnect / reopen decision tree
3. detached target recovery

完成标准：

- browser 恢复行为可预测，不再依赖偶然命中 live handle

### E3. Browser trust integration

目标：

- 把 browser 纳入 tool governance / trust 模型

任务：

1. browser evidence trust level
2. snapshot / console / screenshot 的 admission policy
3. browser fallback 到 API/tool 的反向切换策略

完成标准：

- browser 不再是系统治理外的一块“特殊地带”

当前状态：

- 已完成第一版：
  - ownership model / lease / hot-warm-cold resume matrix
  - scheduled re-entry 的 ownership-aware browser continuation hint
  - browser 结果已进入 trust / admission / governance 主链
  - target-local snapshot/ref history
  - detached / stale / invalid-resume 的 taxonomy 对齐

---

## 9. Workstream F: QC / Replay / Failure Analysis

### F1. 主链 replay 覆盖

目标：

- replay 不只覆盖 browser，还要覆盖 role / worker / tool 主链

任务：

1. trace/span 基础结构
2. role/worker/browser 的统一 replay entry
3. scheduled re-entry 的 trace 连接

完成标准：

- 一条 bounded 任务的主链能完整回看

### F2. Failure taxonomy

目标：

- 把 failure 从“报错字符串”升级成稳定分类

任务：

1. timeout / auth / scope / transport / partial / merge-failure 分类
2. recovery recommendation policy
3. retryability 标记

完成标准：

- failure 分析能指导后续 continue / retry / abort 决策

### F3. Bounded regression harness

目标：

- 给 Production Hardening 留一批稳定回归样本

任务：

1. bounded task fixture
2. expected trace / result shape
3. regression runner

完成标准：

- 每次改 runtime 都能快速验证是否把主链做坏

当前状态：

- 已完成第一版：
  - role / worker / browser / scheduled 主链 replay
  - failure taxonomy 第一版
  - governance surface: permission / audit / replay 查询
  - replay summary / incident / grouped inspection / recovery dispatch / console / workflow-log surface
  - recovery-linked incident bundles / recovery workflow status
  - RecoveryRun / attempt 持久化与 approve/reject/retry/fallback/resume action surface
  - RecoveryRun event log / merged timeline / progress / phase
  - attempt causality / superseded relation / browser-specific recovery outcome
  - repeated retry/fallback escalation 与 approval-resume continuation
  - bounded regression harness 与 browser reliability soak 样本
- 当前剩余重点：
  - recovery/operator surface 的轻量 polish
  - 更细的 failure bucket 与恢复建议继续补齐
  - browser reliability soak 与 recovery 主链联动验证继续扩大样本

---

## 10. 建议执行顺序

建议按 3 个批次推进：

### Batch 1

1. A1 Prompt assembly 顺序稳定化
2. A2 Memory file discipline
3. B1 Continue / retry / resume 语义统一
4. B3 Re-entry stability

目标：

- 先把“继续执行”和“上下文延续”做稳

当前状态：

- 已完成
- 已落地的内容包括：
  1. prompt assembly 稳定元数据
  2. memory / journal / scratchpad / summary 分层持久化
  3. memory compaction boundaries
  4. worker continuity mode
  5. scheduled continuation context
  6. role-level continuity 优先级
  7. timeout -> summarize -> continue 第一版 contract
  8. recall trigger / evidence-seeking query 区分
  9. compact-before-drop prompt packing 与 `compactedSegments`

### Batch 2

1. C1 Fan-out envelope
2. C2 Merge gate and coverage check
3. D1 Transport hierarchy 稳定化
4. D2 Permission / audit / approval
5. D3 Observational vs promotable evidence
6. E1 Ownership and login-state policy

目标：

- 先把并行运行和外部调用的主行为做稳

当前状态：

- 已完成：C1 / C2 / D1 / D2 / D3 / E1
- Browser Runtime v2.6 / ownership-aware re-entry 已完成
- bounded regression harness 与 browser reliability soak 已扩到 browser / recovery / continuity 主链
- Recovery runtime 已进入产品级第一版并基本收住
- browser continuity 已进入 replay / bundle / console / TUI 视图
- 当前判断：Phase 1 的核心机制已经基本具备，但 Phase 1 仍未结束。
- 剩余工作收敛到：
  1. browser reliability 更长链 soak / regression 扩充
  2. operator-facing polish 与 regression / soak 样本继续扩大
  3. context/runtime/operator 三条主线继续做产品化收口

配套文档：

- `docs/design/production-hardening-target-state.md`
- `docs/design/production-hardening-gap-map.md`

### Batch 3

1. B2 Timeout summarize -> continue
2. E2 Resume matrix
3. F1 主链 replay 覆盖
4. F2 Failure taxonomy

目标：

- 把 Production Hardening 从“可工作”推进到“可诊断、可恢复”

调整说明：

- `B2 Timeout summarize -> continue` 的第一版 contract 已在 Batch 1 先补齐
- Batch 3 保留的是更强的可诊断/可恢复产品化，而不是最初的基础语义打底
- `F1 / F2` 的第一版主链能力已落地；Batch 3 现在更偏向 inspection / regression / recovery 产品化
- 当前判断：Batch 3 的主块已经基本收住，剩余工作主要集中在 browser soak/regression 扩充与 operator-facing 的轻量 polish

---

## 11. Phase 1 完成标准

只有满足下面这些条件，才算 Phase 1 真完成：

1. bounded task 在中断、超时、轻度上下文膨胀下仍能稳定继续
2. fan-out 后的 partial / missing / conflicting result 都有稳定 merge 语义
3. browser session / target / login-state 恢复行为可预测
4. official API / business tool / browser fallback 有清晰治理顺序
5. 主链 replay 和 failure analysis 足够支撑日常调试
6. 再进入 `Runtime Kernel Lift` 时，不需要靠“重做第一期”来兜底
