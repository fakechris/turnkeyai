# Production Hardening Gap Map

> 更新日期：2026-04-01  
> 目标：把当前实现与 Phase 1 目标状态之间的剩余差距整理成执行清单。

## 1. 当前判断

Phase 1 的核心机制已经完成。当前差距不再是 pack 级机制缺口，而是同场景 end-to-end 验收、长期 soak 和 real-world validation。

当前最接近目标的是：

- Browser continuity 基础能力
- Replay / incident / recovery runtime
- Layered memory 与 budget-aware packing 第一版
- bounded regression harness 与 browser reliability soak 主链样本
- browser continuity 已进入 replay / bundle / console / TUI 视图

当前还需要继续验证的是：

1. browser reliability 更长链 soak / regression 扩充
2. context continuity 在真实任务和高压预算下的长期稳定性
3. runtime / operator / replay / recovery 跨面一致性继续打磨
4. failure injection 与 real-world validation 样本继续扩大

这一阶段不进入下一期能力建设，而是按模块级产品化矩阵继续收口：

- `docs/design/phase1-productization-matrix.md`

---

## 2. Browser Reliability 剩余差距

### 已有

- ownership / lease
- `hot / warm / cold` resume
- attach / reconnect / reopen / new_target
- target-local snapshot / ref history
- ownership-aware re-entry
- stale / invalid-resume failure taxonomy

### 还缺什么

1. 长链 attach / reconnect / reopen 的 soak 验证
2. idle eviction、lease reclaim、detached target 的协同行为继续收尾
3. target-local ref/snapshot cache 在页面变化后的回退策略继续验证
4. browser reliability 的 incident / replay / operator 视图继续补更长链样本

### 做到什么算收住

1. 长任务里常见的 browser 中断可以稳定恢复
2. 同一 continuity 不会轻易跳错 target
3. browser failure taxonomy 能指导后续 resume / retry / stop 决策

---

## 3. Recovery Runtime 剩余差距

### 已有

- replay summary / incidents / console
- recovery plan / recovery dispatch
- incident bundle / recovery workflow state
- recovery-linked follow-up timeline
- RecoveryRun / attempt 持久化与 approve/reject/retry/fallback/resume action surface
- RecoveryRun event log / merged recovery timeline / phase summary
- attempt causality / superseded relation / browser-specific recovery outcome
- repeated retry/fallback escalation and approval-resume continuation
- bounded regression harness 与 browser reliability soak 样本

### 还缺什么

1. recovery/operator surface 的轻量 polish
2. browser reliability soak 与 recovery policy 一起跑更长链验证
3. 更细的 failure bucket 与恢复建议继续补齐

### 做到什么算收住

1. 一条失败主链能被视为一个完整 recovery case
2. 用户可以一眼看懂当前恢复状态、因果链和下一步动作
3. 自动恢复只发生在明确允许的场景中
4. browser 恢复结果和 recovery case 的关系可直接观察

---

## 4. Context Runtime 剩余差距

### 已有

- summary / memory / journal / scratchpad 分层
- retrieval ranking 第一版
- budget-aware packing 第一版
- tool-result pruning 第一版
- long-running compression 第一版

### 还缺什么

1. ranking 继续调优，减少弱相关信息抢占
2. packing 在高压 token 场景下继续稳定
3. worker/tool evidence 的 admission / pruning 更严格
4. recent-turn compaction 与 continuation packet 的衔接继续加强
5. unresolved question / pending work 的 carry-forward 继续细化

### 做到什么算收住

1. 长任务上下文不轻易漂
2. re-entry / continue 时能拿到更稳的 pending work 和关键事实
3. 工具结果多时，prompt 仍然保持高密度和可解释性

---

## 5. 推荐收尾顺序

建议保持下面顺序，不再扩新主线：

1. Browser reliability 更长链 soak / regression 扩充
2. Context retrieval / packing / pruning 调优
3. Operator-facing polish 与 regression / soak 样本扩充

原因：

- browser 是最容易把长任务拖垮的一环
- context 调优决定持续任务是否稳定
- regression / soak 扩充决定后续迭代不会把主链重新打坏

---

## 6. 当前阶段判断

如果把 Phase 1 的目标定义为：

- bounded 的真实任务可以稳定完成
- continue / reconnect / replay / audit 行为可预期

那么当前更准确的判断是：

- `Phase 1 / Production Hardening` 的核心机制已经完成
- 当前主线变成 acceptance / soak / failure injection，而不是新增机制建设

剩余事项更适合归类为：

1. 稳态维护
2. 更长链 soak / regression 扩充
3. operator-facing 的最后一轮收尾

## 7. 收尾完成后的判断

当上面三块收住之后，Phase 1 的重心就可以从“把主链做稳”转向：

1. 更系统的 real-world acceptance / soak 机制
2. 为下一阶段的 kernel 抽象做准备
3. 保持 recovery / browser / context / runtime 四条主链的稳态

这时再进入更重的 execution / context / policy kernel，会更稳，也更容易验证。
