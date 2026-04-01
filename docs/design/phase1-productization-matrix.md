# Phase 1 Productization Matrix

> 更新日期：2026-04-01  
> 目标：把 `Phase 1 / Production Hardening` 从“核心机制已经具备”推进到“模块级、case 级、operator 级都达到产品化收尾标准”。

## 1. 这份矩阵解决什么问题

当前项目已经不是“有没有核心机制”的问题。这份矩阵现在主要作为 end-to-end acceptance checklist 使用，用来判断：

1. 每个模块离产品化成熟度还差多少
2. 哪些差距必须通过真实 case、长链 soak 和 operator 视图来关闭
3. 什么情况下才算 `Phase 1` 真正完成

因此，这份矩阵不引入新方向，只把 `Phase 1` 继续拆成：

- 模块
- 当前已有
- 剩余差距
- 必跑 case
- 完成验收线

---

## 2. 模块总览

`Phase 1` 收尾只围绕 6 个模块继续推进：

1. Browser Runtime
2. Recovery Runtime
3. Context Runtime
4. Parallel Orchestration
5. Tool Governance
6. Operator Surface

原则只有一个：

> 不再扩新主线，先把现有主线逐模块做到稳定、可诊断、可操作。

---

## 3. Browser Runtime

### 当前已有

- browser session protocol：`spawn / send / history / resume`
- ownership / lease
- `hot / warm / cold` resume
- `attach / reconnect / reopen / new_target`
- target-local snapshot / ref history
- ownership-aware re-entry
- browser continuity 已进入 replay / bundle / console / TUI 视图

### 剩余差距

1. 更长链的 `attach / reconnect / reopen / eviction` 组合 soak
2. detached target / lease reclaim / wrong-owner / reopen 的混合场景继续压
3. target-local ref/snapshot cache 在页面变化后的回退策略继续验证
4. browser continuity 的 operator-facing 摘要继续打磨

### 必跑 case

1. `spawn -> target switch -> detach -> reopen -> hot attach`
2. `detach -> lease expire -> reclaim -> reopen`
3. `wrong owner -> deny -> recover through new target`
4. `eviction -> warm/cold resume -> ref reuse`
5. 多 target 长链切换后继续回到正确 target

### 完成验收线

1. 长任务里的 browser continuity 基本可预测
2. 同一 continuity 不轻易跳错 target
3. browser 中断后，多数组合场景都能稳定导向正确的下一步动作

---

## 4. Recovery Runtime

### 当前已有

- `RecoveryRun`
- attempts / causality / superseded
- event log / timeline / progress / phase
- `approve / reject / retry / fallback / resume`
- browser-specific recovery outcome
- bundle / console / TUI 工单视图

### 剩余差距

1. recovery run 的真实人工操作路径继续压测
2. approval / retry / fallback / resume 组合 case 再压一轮
3. browser recovery 与 recovery case 的绑定继续细化
4. recommendation / next action / current gate 的 operator-facing 文案继续打磨

### 必跑 case

1. `retry -> recovered`
2. `retry -> fallback -> recovered`
3. `waiting_approval -> approve -> resume-again`
4. `waiting_approval -> reject -> aborted`
5. `retry -> fallback -> inspect_then_resume`
6. browser stale session 触发 recovery 并走到目标 target 恢复

### 完成验收线

1. 一条失败主链能稳定被视为一个 recovery case
2. 当前 gate、因果链、下一步动作一眼可懂
3. 自动恢复只发生在明确允许的场景中

---

## 5. Context Runtime

### 当前已有

- summary / memory / journal / scratchpad / evidence 分层
- recall trigger / retrieval ranking 第一版
- budget-aware packing 第一版
- tool-result pruning 第一版
- long-running compression 第一版
- pending / unresolved carry-forward
- compact-before-drop packing 与 `compactedSegments`

### 剩余差距

1. ranking 继续调优，减少弱相关抢占
2. packing 在高压 token 场景下继续稳定
3. tool evidence admission / pruning 继续收紧
4. continuation packet 与 packed context 的优先级再压实
5. long-chain compaction 与 flush policy 继续产品化

### 必跑 case

1. 多轮工具结果后仍保住 pending work / open questions
2. evidence-heavy 任务不会被弱 observational 信息抢占
3. long-running task 在高压预算下仍保住关键 continuity
4. re-entry / continue 后 pending work 与 unresolved question 继续稳定

### 完成验收线

1. 长任务上下文不明显漂
2. re-entry 后关键 pending work / evidence / open questions 仍稳定
3. prompt 裁切行为可解释

---

## 6. Parallel Orchestration

### 当前已有

- fan-out / shard group
- merge gate / coverage
- duplicate / conflict detection
- research shard / merge-synthesis packet
- follow-up policy

### 剩余差距

1. timeout / cancel / retry 组合场景继续压测
2. merge coverage / duplicate / conflict 的 operator 视图继续打磨
3. parallel shard 的 replay / inspection 样本继续扩大

### 必跑 case

1. 三路 shard 全成功并 merge
2. 缺一 shard 导致 follow-up
3. duplicate / conflict 命中后 merge gate 正确阻断
4. timeout shard 经 retry 后再进入 merge

### 完成验收线

1. fan-out / fan-in 不只是能跑，而且可诊断、可恢复
2. partial merge 不会误当 final

---

## 7. Tool Governance

### 当前已有

- capability discovery
- permission cache
- trust grading
- prompt admission
- transport hierarchy audit
- governance event / audit 查询

### 剩余差距

1. 多 worker / 多 transport 场景继续压测
2. permission / downgrade / fallback 决策在 operator 视图里的可读性继续打磨
3. trust / admission / audit 术语继续统一

### 必跑 case

1. official API 成功直达
2. API denied 后 fallback 到 browser 或 business tool
3. approval-required 被阻断并正确进入 recovery / operator 视图
4. observational evidence 不应越权进入 memory / final prompt

### 完成验收线

1. 外部调用为何允许、为何降级、为何拦截都能直接解释
2. governance 不再只是内核逻辑，而是可观测、可调试

---

## 8. Operator Surface

### 当前已有

- replay console
- replay bundle
- recovery run / timeline
- regression cases / regression run
- browser continuity 已进入 operator 视图

### 剩余差距

1. 术语统一
2. 当前 gate / 推荐动作 / failure 摘要继续产品化
3. recovery / browser / regression 输出进一步面向操作者，而不是研发原始视图
4. 首页级 summary 与跨面 attention 清单继续收口

### 必跑 case

1. 不看代码，仅靠 console / bundle / timeline 能定位 browser continuity 问题
2. 不看测试日志，仅靠 recovery run 能判断为什么卡在审批、fallback 或 resume
3. regression run 输出能快速判断哪条主链退化

### 完成验收线

1. 失败后更像“可操作工单”，而不是“日志集合”
2. operator 不翻源码也能完成一轮排障

---

## 9. 推荐执行顺序

`Phase 1` 后续只按下面顺序继续：

1. Browser Runtime
2. Recovery Runtime
3. Context Runtime
4. Operator Surface
5. Regression / soak expansion 贯穿全程

原因：

- browser 是最长链、最容易把真实任务拖垮的一环
- recovery 是最直接的操作者闭环
- context 决定长任务会不会漂
- operator surface 决定这些能力是否真能被用起来

---

## 10. Phase 1 真正完成的标准

只有同时满足下面条件，`Phase 1` 才算真正完成：

1. browser continuity 在长链任务下基本可预测
2. recovery case 能稳定从失败推进到 recovered / aborted / manual follow-up
3. context 在高压预算与长任务下仍保持稳定
4. parallel / governance / operator surface 不再是主链弱点
5. regression / soak 套件覆盖主链并持续保持绿色
