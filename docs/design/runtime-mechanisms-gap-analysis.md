# 核心机制差距分析

> 更新日期：2026-03-28
> 目的：在继续开发前，把当前实现、目标机制、差距和决策讲清楚

---

## 1. 当前阶段判断

当前项目已经不是“空设计”，也不是“只会跑 demo”。

现在已经具备：

1. `Team -> Role -> Worker -> BrowserBridge` 的最小闭环
2. 多模型 adapter 抽象
3. 基础的 handoff / flow / run / message 持久化
4. 最小 browser action 链
5. 最小 QC / replay 记录
6. capability discovery / scheduled re-entry / API diagnosis 第一版
7. `browser / explore / finance` 三类 worker 的第一版运行链

但它仍然不是最终机制。

更准确地说，当前状态是：

- 运行时骨架：已经成型
- 产品核心机制：只完成了第一版
- 真实产品级稳定性：还差一大截

---

## 2. 当前最优先方向

现阶段不应该优先做 Electron 壳。

原因很直接：

1. 现在已经有 `daemon + TUI`，足够验证流程可行性
2. 真正的风险不在 UI，而在浏览器会话、worker 协议、上下文管理、失败恢复
3. 如果核心机制没定清楚，GUI 只会把错误更早固化

因此当前优先级调整为：

1. `Persistent Browser Session`
2. `Structured Worker Protocol`
3. `Prompt / Context / Compression`
4. `QC / Replay / Recovery`
5. `Electron Shell`

换成更高层的表达，其实就是：

1. `Browser Runtime`
2. `General Subagent Runtime`
3. `Context / Memory Runtime`
4. `QC / Replay`
5. `Desktop Shell`

补充：

这五项现在不能再只理解成 browser / worker / prompt 三条独立线。
更合理的产品机制应该把它们连起来看：

1. capability discovery / authorization / API readiness
2. official API / business tool / browser fallback hierarchy
3. prompt-bearing scheduled re-entry
4. API diagnosis and repair loop

---

## 3. Relay 浏览器桥的决策

关于开源浏览器扩展桥，不建议简单“直接拿来用到底”，也不建议一开始就完全重写全部。

更合理的路线是：

### 3.1 短期

短期可以兼容它的技术原理，必要时复用其一部分行为模型：

1. Chrome 扩展驻留在用户浏览器
2. 本地桌面端维护 bridge / session / target
3. browser tool 通过本地 bridge 执行动作

短期目标是：

- 先把我们自己的 browser bridge contract 稳定下来
- 不把 runtime 直接绑死在第三方 relay 实现细节上

### 3.2 中期

中期应该把协议和 bridge 实现掌握在自己手里：

1. 自己定义 `BrowserTaskRequest / BrowserTaskResult / BrowserActionTrace`
2. 自己维护 `session / target / ref / artifact` 生命周期
3. 扩展只作为 transport adapter，而不是产品内核

### 3.3 结论

结论是：

- 不是“完全照搬既有实现”
- 也不是“忽略现成原理从零瞎做”
- 而是“参考其链路原理，但实现自己的 bridge contract 和 runtime ownership”

换句话说：

我们应该自研浏览器桥，只在必要处兼容既有浏览器桥的技术路径。

---

## 4. 现状与最终机制的真实差距

下面这 6 个问题，需要区分：

1. 设计里是否存在
2. 代码里是否已经存在
3. 是否已经达到最终机制

### 4.1 明确角色设定、Team、Team 之间 delegate

当前状态：

- `角色设定`：有
- `Team`：有
- `Team 内 handoff`：有
- `Team 之间 delegate`：没有

代码证据：

- 角色和 team 结构在 [team.ts](../../packages/core-types/src/team.ts)
- handoff 主链在 [coordination-engine.ts](../../packages/team-runtime/src/coordination-engine.ts)

当前能力：

1. 一个 thread 内有 lead/member 角色
2. role reply 可以通过 mention 触发下一个 role
3. flow ledger 会记录 handoff edge

缺口：

1. 还没有 “team of teams”
2. 没有跨 team 路由协议
3. 没有上层 orchestrator 去做 team-level delegation

结论：

- `单 team 多角色协作`：已存在
- `team 之间 delegate`：目标态，未实现

### 4.2 角色会启动 Subagent 去做具体工作

当前状态：

- 已存在，但目前是 `role -> worker`，不是完整意义上的通用 subagent runtime

代码证据：

- 角色内启动 worker 在 [policy-role-runtime.ts](../../packages/role-runtime/src/policy-role-runtime.ts)
- worker 生命周期在 [in-memory-worker-runtime.ts](../../packages/worker-runtime/src/in-memory-worker-runtime.ts)

当前能力：

1. Role runtime 可以 `spawn -> send -> getState`
2. 当前已有 `browser / explore / finance` 三类 worker
3. worker 结果会注入回角色 prompt 和 message metadata
4. scheduled task 可以重新激活 role / worker 链

缺口：

1. 当前 worker 更像受控执行器，不是完整的通用 subagent
2. 没有 worker memory / worker thread / worker cold resume
3. 没有 worker-to-worker delegation
4. coder / harness 还没有真实实现
5. 还没有统一的长期 session ownership 策略

结论：

- `角色启动子执行单元`：已存在并进入第二阶段
- `通用 Subagent Runtime`：仍未完成

补充缺口：

1. capability discovery 已有第一版，但还不够细
2. connector / API readiness 已进入 worker 选择，但还没有产品级策略
3. scheduled task 已能回流 thread / worker，但还没有长期恢复语义

### 4.3 角色和 Subagent 使用不同模型

当前状态：

- 能做到，但不是自动策略化完成

代码证据：

- 角色模型配置在 [team.ts](../../packages/core-types/src/team.ts)
- LLM 调用在 [llm-response-generator.ts](../../packages/role-runtime/src/llm-response-generator.ts)
- 多 provider catalog 在 [types.ts](../../packages/llm-adapter/src/types.ts)

当前能力：

1. 每个 role 可以配置自己的 `provider + model`
2. LLM adapter 已支持 openai-compatible / anthropic-compatible
3. worker 本身可以独立运行，不强依赖 role 使用同一模型

缺口：

1. browser worker 当前主要是程序执行，不依赖独立 LLM
2. 还没有 “role model policy” 和 “worker model policy”
3. 没有 provider fallback matrix
4. 没有按任务类型动态选模型

结论：

- `不同角色配置不同模型`：已存在
- `角色与 subagent 明确采用不同模型策略`：能力上可支持，但尚未产品化

### 4.4 Subagent 做浏览器操作时，那一系列操作是不是都有

当前状态：

- 有一部分，而且是真实浏览器动作，不是 mock

代码证据：

- action 执行在 [chrome-session-manager.ts](../../packages/browser-bridge/src/chrome-session-manager.ts)
- DOM snapshot / ref 生成在 [dom-snapshot.ts](../../packages/browser-bridge/src/dom-snapshot.ts)
- browser worker 入口在 [browser-worker-handler.ts](../../packages/worker-runtime/src/browser-worker-handler.ts)

当前已有动作：

1. `open`
2. `snapshot`
3. `click`
4. `type`
5. `scroll`
6. `console`
7. `screenshot`

当前也已有：

1. `refId`
2. trace
3. screenshot artifact
4. step/result verification

缺口：

1. 还没有 persistent profile
2. 没有真实登录态管理
3. 没有多 tab / target attachment 管理
4. 没有结构化 permission model
5. 没有 session resume
6. 没有真正的 browser-side long-running worker

结论：

- `浏览器动作链`：已存在最小版
- `产品级 browser runtime`：还没有

补充：

浏览器链也不该再被理解成唯一主执行路径。更完整的目标机制应该允许：

1. 先走 official API
2. 再走 business tool / remote tool
3. 最后才走 browser fallback

也就是说，browser worker 应该是 transport hierarchy 的一环，而不是默认入口。

补充判断：

当前阶段不应该把注意力放在“继续补静态网页抓取”这类局部能力上。
真正重要的是：

1. session ownership
2. tab / target lifecycle
3. relay / cdp / browser fallback 的统一抽象
4. worker/session resume 的一致性

### 4.5 Prompt 是怎么设定的

当前状态：

- 有 prompt policy，但很薄

代码证据：

- prompt 拼装在 [prompt-policy.ts](../../packages/role-runtime/src/prompt-policy.ts)
- 角色 profile 在 [role-profile.ts](../../packages/role-runtime/src/role-profile.ts)

当前 prompt 组成：

1. `systemPrompt`
2. `taskPrompt`
3. `outputContract`
4. `suggestedMentions`

当前 prompt 来源：

1. 角色 seat
2. 角色 profile
3. 最近几条消息
4. relay brief
5. 当前 flow / activation metadata

缺口：

1. 没有模板系统
2. 没有 prompt layering
3. 没有 skill instruction 注入
4. 没有 role bootstrap files
5. 没有 worker-specific prompt families
6. 没有 prompt versioning / A/B

结论：

- `Prompt 机制`：有
- `产品级 Prompt 体系`：远未完成

### 4.6 上下文怎么管理？快满时怎么压缩

当前状态：

- 基本没有

代码证据：

- 当前 prompt 只拿 `recentMessages.slice(-3)`，见 [prompt-policy.ts](../../packages/role-runtime/src/prompt-policy.ts)
- 没有专门的 compression / summarization / memory 包

当前做法本质上只是：

1. 只取最近几条消息
2. 用 `relayBrief` 做非常薄的转述
3. 没有 token budget 管理

缺口：

1. 没有上下文窗口估算
2. 没有压缩阈值
3. 没有 thread summary buffer
4. 没有 role-local memory
5. 没有 worker transcript compaction
6. 没有分层上下文策略

结论：

- `上下文管理`：只有最小占位
- `上下文压缩`：当前不存在

这是现在离最终机制差距最大的地方之一。

### 4.7 计划型回流机制

当前状态：

- 只有即时 handoff / worker 执行

目标机制应增加：

1. prompt-bearing scheduled task
2. conversation-bound re-entry
3. same-thread future activation
4. task capsule 持久化

原因：

长期工作流不能只靠当前上下文窗口和手工 follow-up。

### 4.8 API 诊断与自修复机制

当前状态：

- 有基础错误处理

目标机制应明确区分：

1. credential invalid
2. credential valid but scope missing
3. schema mismatch
4. business mutation failure
5. transport unavailable -> browser fallback

原因：

对真实业务系统做写操作时，这种分层诊断会显著影响成功率和可恢复性。

---

## 5. 当前机制 vs 最终机制

建议把最终机制定义为下面这套链路：

`User Intent -> Lead Role -> Member Role -> Worker/Subagent -> Browser Bridge / Other Tooling -> QC/Replay -> Lead Convergence`

并配套这 5 套基础机制：

### 5.1 Prompt Stack

目标：

1. role identity
2. role policy
3. team policy
4. tool policy
5. task overlay
6. memory summary
7. worker feedback

当前只做到了：

1. role identity
2. task prompt
3. output contract

### 5.2 Context Stack

目标：

1. recent turns
2. compact summary
3. role-local working memory
4. worker trace summary
5. artifact references
6. token budget policy

当前只做到了：

1. recent turns 的极简版

### 5.3 Worker Protocol

目标：

1. `spawn`
2. `send`
3. `getState`
4. `resume`
5. `interrupt`
6. `attachArtifact`
7. `emitTrace`

当前只做到了：

1. `spawn`
2. `send`
3. `getState`

### 5.4 Browser Protocol

目标：

1. persistent session
2. structured actions
3. page refs
4. permissions
5. artifacts
6. replay
7. session resume

当前只做到了：

1. structured actions
2. page refs
3. artifacts
4. minimal replay metadata

### 5.5 Recovery / QC

目标：

1. step verifier
2. result verifier
3. retry policy
4. model fallback
5. worker fallback
6. replay viewer

当前只做到了：

1. step verifier
2. result verifier
3. replay file
4. basic recovery

---

## 6. 接下来该怎么开发

### 6.1 第一优先级：Persistent Browser Session

要做：

1. browser profile
2. 登录态复用
3. session resume
4. tab / target 管理
5. 长任务不中断

原因：

- 这是最接近真实产品能力的核心差距

### 6.2 第二优先级：Structured Worker Protocol

要做：

1. worker envelope 升级
2. worker session state
3. worker resume / interrupt
4. worker artifact channel
5. browser worker 与后续 coder/finance worker 对齐

原因：

- 不先把这个做稳，后面多 worker 会越来越乱

### 6.3 第三优先级：Prompt / Context / Compression

要做：

1. role prompt stack
2. task overlay
3. summary buffer
4. token budget
5. compression policy
6. worker transcript compaction

原因：

- 这是从“能跑”进入“能长期工作”的分水岭

### 6.4 第四优先级：QC / Replay 深化

要做：

1. richer replay schema
2. step viewer data model
3. verifier result normalization
4. recovery policy matrix

### 6.5 最后再做 Electron Shell

这一步不是不做，而是放后：

1. runtime 稳定后再做 GUI 才有意义
2. 否则 UI 只能包装一堆还没定型的机制

---

## 7. 明确结论

当前可以明确下来的结论是：

1. 我们已经有 `Team -> Role -> Worker -> BrowserBridge` 的最小真实链路
2. 这条链路已经足够验证产品方向
3. 但它离最终机制还有 3 个最大缺口：
   - `Browser Runtime`
   - `General Subagent Runtime`
   - `Context / Memory Runtime`
4. 浏览器扩展桥层不应该成为产品核心，只应作为桥接参考或 transport adapter
5. Electron 壳现在不是第一优先级

所以接下来不是继续扩单个业务链，而是先把这 3 个核心机制做稳。
