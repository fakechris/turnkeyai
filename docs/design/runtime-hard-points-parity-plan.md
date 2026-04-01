# Runtime Hard-Points Parity Plan

> 更新日期：2026-04-01
> 目标：针对复杂长链最难点，系统补齐已验证最稳的关键执行机制
> 原则：关键机制要么整套引入，要么先不引；避免“部分借鉴导致系统半稳半脆”

---

## 1. 这份计划解决什么

当前 TurnkeyAI 已经具备：

- `DispatchEnvelope`
- `ReplayRecord`
- `RecoveryRun`
- `BrowserSessionRuntime`
- `RuntimeChain`
- `OperatorSummary / OperatorAttention`

这些基础已经足够强。

当前真正的差距不在“是否有对象模型”，而在：

1. session continuity 是否像产品 runtime 一样稳
2. live progress 是否像原生 execution stream 一样可见
3. request/tool/media 大内容治理是否像系统硬约束一样完整
4. memory/compact 是否是持续后台收敛，而不是临门一脚
5. event/state 上传与传播是否有成熟 backpressure 约束

---

## 2. 吸收原则

### 2.1 不抄外形，只抄成熟机制

不复制：

- 既有外部产品的 REPL UI
- 远程桥接协议细节
- 产品 message schema

重点吸收：

- continuity
- progress
- limits
- compaction
- uploader discipline

### 2.2 关键 pack 必须整套引入

以下机制不建议拆开做：

1. `Session continuity pack`
2. `Progress event pack`
3. `Large-output governance pack`
4. `Memory/compact discipline pack`
5. `Uploader/backpressure pack`

### 2.3 保留现有显式 runtime 模型

这轮不是推翻：

- `ReplayRecord`
- `RecoveryRun`
- `RuntimeChain`

而是让这些对象背后的 live runtime 更稳。

---

## 3. 工作包

## 3.1 Package A — Session Continuity Pack

目标：

- 把 continuity 从“可恢复”推进到“运行中稳态”

整套内容：

1. session-level heartbeat / response-timeout 语义
2. browser/worker/session close code taxonomy
3. transient-not-found / transient-detached 的有限重连窗口
4. control path 与普通消息/动作路径分离
5. echo/progress 级 liveliness 判定

为什么必须整套做：

- 只有重连没有 liveliness，会误判
- 只有 heartbeat 没有 failure taxonomy，会误重试
- 只有 reconnect 没有 control separation，会把权限/中断流打乱

验收：

1. 长链 browser/recovery/worker 任务里，能清楚区分：
   - still alive
   - reconnecting
   - transiently unavailable
   - terminally dead
2. continuity 问题不再主要靠事后 recovery 才看见

---

## 3.2 Package B — Progress Event Pack

目标：

- 让执行中的 progress 成为 runtime 原生主链，而不是只靠 replay/operator 事后投影

整套内容：

1. 统一 progress event 模型
2. runtime chain span 的 live phase event
3. compact / boundary / transition 明确事件化
4. role/worker/browser/recovery 的 heartbeat event
5. TUI/runtime surface 直接显示 progress stream

为什么必须整套做：

- 只补 progress 文案，没有 phase event，无法做 stale/waiting 判断
- 只补 runtime query，没有 live event，用户仍然感觉系统“没动静”

验收：

1. runtime view 能看见当前链在跑什么
2. operator 不用先跳 replay 才知道系统是不是还活着

---

## 3.3 Package C — Large-Output Governance Pack

目标：

- 把请求包膨胀风险从“局部 guard”升级成“系统纪律”

整套内容：

1. request envelope hard guard
2. per-tool result hard limit
3. per-turn aggregate result budget
4. tool/media/attachment reference-first policy
5. oversize persist-and-reference
6. provider-facing image/pdf/media hard caps
7. retry-must-shrink on overflow-like failures

为什么必须整套做：

- 只做总闸门，不做 per-turn aggregate，仍会在细路径里爆
- 只做落盘，不做 attachment/media cap，仍会在 multimodal 上爆
- 只做 local overflow，不做 provider overflow shrink，仍会重复重打巨包

验收：

1. 长历史、长输出、长附件链路不会把 request envelope 静默推大到危险区
2. oversize 路径优先转为 file/path/reference，而不是继续塞 prompt

---

## 3.4 Package D — Memory / Compact Discipline Pack

目标：

- 把 context 收敛从“请求前预算”推进到“持续后台 discipline”

整套内容：

1. session memory 文件
2. background extraction / update worker
3. sectioned template + section budgets
4. system prompt section cache
5. tool-result microcompact
6. time-based compact + request-time compact 协同

为什么必须整套做：

- 只做 memory file，不做 section budget，会继续膨胀
- 只做 compact，不做后台 extraction，长期 continuity 还是漂
- 只做请求前裁切，不做持续收敛，复杂任务仍会慢慢失真

验收：

1. 长任务上下文更稳
2. re-entry 后 pending work / open questions / key decisions 保持稳定
3. context 漂移主要发生在已知、可观测边界，而不是随机退化

---

## 3.5 Package E — Uploader / Backpressure Pack

目标：

- 为 runtime event/state 的传播补成熟输运层

整套内容：

1. serial batch uploader
2. max batch count + max batch bytes
3. retry/backoff/drop semantics
4. coalescing state uploader
5. bounded queue + backpressure

为什么必须整套做：

- 只做 enqueue 没有 backpressure，负载高时自己拖死自己
- 只做 retry 没有 coalescing，会把状态更新放大成风暴
- 只做 batch 没有 byte budget，网络层同样会炸

验收：

1. runtime observability 本身不会成为新不稳定源
2. 高频 progress/state 更新不会无限堆积

---

## 4. 推荐顺序

按收益和风险，建议顺序：

1. `Package C — Large-Output Governance Pack`
2. `Package B — Progress Event Pack`
3. `Package A — Session Continuity Pack`
4. `Package D — Memory / Compact Discipline Pack`
5. `Package E — Uploader / Backpressure Pack`

理由：

1. 内容膨胀是最直接能把 session 打坏的风险
2. progress/live event 是最直接改善复杂场景可控性的点
3. session continuity 与 progress 搭起来后，才能真正稳定
4. memory/compact 要在 continuity 和 guard 稳住后再深推
5. uploader/backpressure 在 remote/telemetry 继续扩大时价值最高

---

## 5. 当前与目标的差距判断

## 5.1 已经接近的点

1. `RuntimeChain`
2. `RecoveryRun`
3. `BrowserSessionRuntime`
4. `RequestEnvelopeGuard`
5. `RuntimeProgressEvent`
6. `ThreadSessionMemory`
7. `SerialBatchUploader / CoalescingStateUploader`

## 5.2 当前剩余重点

1. 把这些机制继续放到同场景 end-to-end 验收里反复验证
2. 在真实长链和 failure injection 场景下继续积累稳态结论
3. 当未来接入新媒介、新 remote sink 形态时，沿同一机制继续扩展

---

## 7. 当前进展

截至当前版本，已完成：

1. `Package C — Large-Output Governance Pack`
   - request envelope hard guard
   - provider overflow shrink
   - `compact -> minimal -> reference-only` shrink path
   - worker evidence 的 `reference-first` 压缩

2. `Package B — Progress Event Pack`
   - `RuntimeProgressEvent`
   - thread/chain scoped progress store
   - role/worker/browser/recovery progress publication
   - runtime reduction boundary event
   - progress echo/control-path 已进入 continuity 判定
   - TUI:
     - `runtime-progress`
     - `runtime-chain-progress`

3. `Package A — Session Continuity Pack`
   - session-level `responseTimeoutAt / reconnectWindowUntil`
   - browser/worker/session close taxonomy
   - transient reconnect window
   - control-path continuity signals
   - progress/echo-based liveliness overlay

4. `Package D — Memory / Compact Discipline Pack`
   - `ThreadSessionMemory`
   - context maintainer 的持续更新与 session-memory fingerprint 去抖
   - system prompt cache
   - session memory 已进入 prompt assembly / retrieval / continuation recall

5. `Package E — Uploader / Backpressure Pack`
   - `SerialBatchUploader`
   - `CoalescingStateUploader`
   - `runtime.state` coalesced publication
   - retry/backoff/drop semantics
   - uploader failure/drop audit visibility

本轮继续补平的主机制：

1. `Package C — Large-Output Governance Pack`
   - provider-aware request envelope limits
   - `toolResult* / inlineImage* / inlinePdf*` 细粒度指标
   - per-provider media/tool hard caps
2. `Package D — Memory / Compact Discipline Pack`
   - durable `SessionMemoryRefreshJobStore`
   - background `SessionMemoryRefreshWorker`
   - bounded system prompt section cache
   - session memory refresh progress boundary
3. `Package E — Uploader / Backpressure Pack`
   - file-backed remote sink outbox
   - `OutboxBatchShipper`
   - remote progress/state forwarding 的 durable retry/drop 语义

当前剩余主要是后续扩展项和验证项，而不是 hardest-points pack 级缺口：

1. 当未来接入真正的 `tools / multimodal / inline attachments` 出网路径时，把新增媒介继续接到同一套 envelope hint 上
2. 如果部署形态扩展到独立 remote sink 进程，再把当前 durable outbox/shipper 接到实际外部传输端点

---

## 6. 实施边界

这轮不做：

1. 完整 tracing backend
2. REPL/product UI 重做
3. 推翻现有 replay/recovery/operator 架构
4. 复制外部产品的远程桥协议

这轮只做：

1. 在现有 runtime objects 之下补更成熟的执行机制
2. 让现有 operator/runtime views 站在更稳的 live substrate 上

---

## 7. 最终目标

完成后，TurnkeyAI 在 hardest points 上应达到：

1. request envelope 不容易爆炸
2. 长链执行更可预测
3. live progress 更清楚
4. recovery/browser/worker 的 continuity 更自然
5. context 在复杂任务里更稳
6. runtime observability 既有显式对象，又有更强 live substrate

一句话说：

> 保留 TurnkeyAI 当前更清楚的 runtime object model，同时把已验证最稳的底层机制整套吸进去。
