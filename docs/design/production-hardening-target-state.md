# Production Hardening Target State

> 更新日期：2026-04-01  
> 目标：把 Phase 1 剩余主线的目标状态写清楚，明确“做到什么才算够稳”。

## 1. 这份文档解决什么问题

当前系统已经具备：

- 本地可跑的 Team / Role / Worker / Browser 主链
- 可恢复的 browser continuity
- 可检查的 replay / recovery surface
- 基础可用的 context / memory / compression

当前这些目标状态的主机制已经基本落地。现在的重点已经不是“有没有这些能力”，而是：

> 这些能力在真实连续任务里是否足够稳定、可预测、可恢复。

因此，这份文档现在主要作为 end-to-end 验收的目标线，继续关注 3 条主线：

1. Browser reliability
2. Recovery runtime
3. Context runtime

---

## 2. Browser Runtime: Predictable Continuity

### 当前基线

当前 browser runtime 已经具备：

- ownership model
- lease claim / release / expire / reclaim
- `hot / warm / cold` resume
- `attach / reconnect / reopen / new_target`
- target-local snapshot / ref history
- ownership-aware re-entry

### 目标状态

browser runtime 达标后，系统应该满足下面 5 个条件：

1. 同一个 thread / role / worker 的 browser continuity 是可预测的
2. detached target、idle eviction、expired lease 都会进入清晰的恢复路径
3. target 恢复不依赖“偶然命中 live handle”
4. 登录态、profile、session、target 的归属边界稳定
5. browser 失败会落入统一 failure taxonomy，而不是散落成字符串错误

### 用户可感知的效果

- 长任务继续执行时，不会轻易跳错 tab 或丢掉当前页面
- 中断后回来，系统更容易回到正确的 browser state
- 浏览器任务失败后，能明确知道是 lease、target、transport 还是 page state 出了问题

### 完成标准

达到下面这些条件，才算 browser runtime 进入稳态：

1. attach / reconnect / reopen / new_target 的决策树在 replay 里清晰可见
2. wrong-owner / expired-lease / detached-target 不会静默复活旧 session
3. target-local ref/snapshot cache 能覆盖常见的重连与页面变动场景
4. idle eviction 和 re-entry 不会互相打架
5. 长链 browser 任务可以稳定连续执行而不明显串线

---

## 3. Recovery Runtime: Recovery As A First-Class Execution Path

### 当前基线

当前 recovery 主线已经具备：

- replay summary / incidents / grouped inspection
- recovery plan
- recovery dispatch
- incident bundle
- recovery-linked workflow log

### 目标状态

recovery runtime 达标后，系统应该满足下面 5 个条件：

1. 失败后的恢复不是旁路逻辑，而是主执行链的一部分
2. `retry / fallback / resume / manual follow-up` 的边界清楚
3. 一次恢复过程中的多轮尝试都属于同一个 recovery run
4. bundle 能说明恢复是否成功、卡在哪一层、下一步该做什么
5. 失败分类、恢复建议和恢复执行结果三者是一致的

### 用户可感知的效果

- 失败任务更像“可操作的恢复工单”，而不是一串日志
- 用户可以判断系统是在恢复中、已恢复、恢复失败，还是需要人工介入
- 同一任务的恢复历史能连续追踪，不用靠手工拼接

### 完成标准

达到下面这些条件，才算 recovery runtime 进入稳态：

1. recovery dispatch 之后的 follow-up 执行都能回挂到同一 incident bundle
2. `retryable / blocked / permission_denied / invalid_resume / terminal` 都有稳定 next-action
3. 自动恢复只会发生在明确可自动恢复的分支上
4. 需要人工判断的情况会明确停在 `manual_follow_up`
5. replay console 能一眼看出某次恢复链的状态、结果和下一步动作

---

## 4. Context Runtime: Budgeted, Layered, And Recoverable

### 当前基线

当前 context runtime 已经具备：

- thread summary
- thread memory
- thread journal
- role scratchpad
- worker evidence digest
- retrieval ranking 第一版
- budget-aware packing 第一版
- long-running compression 第一版

### 目标状态

context runtime 达标后，系统应该满足下面 5 个条件：

1. 长期信息、短期运行信息、工具证据各有稳定边界
2. prompt packing 受硬预算和硬优先级控制
3. worker / tool 结果不会无节制进入 prompt
4. 长任务压缩后的上下文仍然保留足够的 continuity
5. recovery / re-entry / continue 场景下，context 组包行为可解释

### 用户可感知的效果

- 连续对话和长任务不容易漂
- 任务中断后继续，系统仍然能保留正确的 pending work 和关键结论
- 工具结果很多时，系统不会因为上下文塞满而明显失真

### 完成标准

达到下面这些条件，才算 context runtime 进入稳态：

1. retrieval ranking 对 durable memory、recent journal、worker evidence 有稳定优先级
2. section-level packing 在 token 紧张时有可预测裁切
3. tool-result pruning 不会把噪声直接抬进 prompt
4. long-running compression 能把 recent turns 压缩成连续可用的执行上下文
5. re-entry / continuation / recovery 的 context packet 能说明来源、裁切和 continuity 依据

---

## 5. Phase 1 收尾的验收线

Phase 1 不需要一步做到最理想的 execution kernel，但至少要维持下面这条线并在真实场景中反复验证：

1. bounded 真实任务可以稳定跑完
2. browser continuity 行为可预测
3. recovery 行为可检查、可继续、可停止
4. context packing 不会因为轻度膨胀而明显漂移
5. 主链问题可以通过 replay / incident / bundle 快速定位

满足这些条件之后，再进入更重的 kernel 抽象，会明显更稳。
