# 核心机制洞察与未解问题

> 更新日期：2026-03-28
> 目的：把已有运行时研究提炼成与新系统直接相关的机制洞察，并明确仍需继续深挖的问题

---

## 1. 为什么还不能只看“链路通了”

链路打通只能说明：

1. 消息能流动
2. 角色能接力
3. worker 能被调用
4. browser 能执行动作

但真正决定系统上限的，不是这条主链，而是这些隐藏机制：

1. prompt 如何分层装配
2. 上下文如何裁剪、压缩、恢复
3. 子会话如何续跑、复用、失效
4. 任务如何拆分、验证、收敛
5. 浏览器句柄、页面 ref、artifact 如何跨步骤稳定传递
6. 并行窗口、失败恢复、超时总结如何避免系统失控

如果这些机制没想清楚，系统只能停留在“能跑 demo”的层级。

---

## 2. 已经提炼出来的关键机制

### 2.1 角色不是单 prompt，而是 prompt bundle

更合理的角色抽象应包含：

1. identity
2. workflow rules
3. tool policy
4. memory policy
5. user customization
6. runtime overlay

这意味着后续不该继续把角色只做成：

- `name + systemPrompt + model`

而应做成可持久化的 prompt bundle。

### 2.2 最终 prompt 必须是运行时装配结果

系统真正送入模型的内容，不应该直接来自一个模板文件。

更稳定的做法是分层装配：

1. role bundle
2. environment block
3. workspace block
4. memory block
5. team block
6. tool whitelist block
7. task overlay
8. output contract

后续 prompt 调优也应该发生在这些层之间，而不是只改一段长提示词。

### 2.3 Team 协作不是“群聊”，而是半结构化 handoff

更好的 team runtime 至少要有三条规则：

1. lead role 负责决定下一棒
2. member role 默认不抢答
3. mention 是调度命令，不是展示符号

这意味着 mention 之后真正传递的不是“原消息”，而应该是：

1. 最近对话片段
2. handoff brief
3. 目标角色说明
4. 停止条件
5. 下一步预期

### 2.4 子代理最关键的不是 spawn，而是 session

现有研究已经说明，真正重要的是：

1. `spawn`
2. `history`
3. `send/follow-up`
4. `status`
5. `timeout summarization`
6. `session persistence`

所以通用 worker/subagent 层不应该被设计成一次性函数调用。

它更像：

- 一个短生命周期但可续跑的 execution session

### 2.5 浏览器 worker 不是浏览器 RPC，而是独立执行者

浏览器 worker 应该具备：

1. 独立 prompt
2. 独立 session
3. 独立模型或执行策略
4. 独立 trace
5. 独立产物持久化

这和“主角色直接调一个 browser API”是两种完全不同的产品形态。

### 2.6 浏览器桥至少要分成两层

浏览器系统不应该只建一个 bridge 类。

更合理的拆分是：

1. transport primitives
2. page interaction runtime

前者负责：

1. session / target / tab
2. extension / CDP / local control
3. attach / detach / focus / close

后者负责：

1. open
2. snapshot
3. click / type / wait / scroll
4. screenshot
5. evaluate / console
6. ref restore

### 2.7 页面 ref 是一层语义句柄，不是 UI 装饰

snapshot 不是只是给模型看页面文本。

snapshot 还应该同时生成：

1. ref id
2. role / label / nth mapping
3. restore metadata

后续 click/type/scrollIntoView 等动作应尽量优先走 ref，而不是重新猜 selector。

### 2.8 质量控制不能只靠最终结果检查

更稳的 runtime 应该把 QC 切成三层：

1. pre-execution policy
2. step verification
3. result verification

并在超时或失败时支持：

1. partial summary
2. retry
3. fallback
4. abort with evidence

### 2.9 超时总结是必要机制

复杂 worker 不应该一旦超时就直接硬杀。

应该有：

1. soft timeout
2. evidence-only summarization
3. hard timeout

这能显著减少“任务失败时回答全空”或“超时后开始编造结果”。

### 2.10 并行窗口和串行表象是两回事

用户看到的消息顺序不一定等于底层 queue 的真实并行关系。

这提醒我们：

1. flow graph
2. active role set
3. queue state
4. iteration cap

都必须显式建模，而不能只看 message timeline。

### 2.11 capability discovery 应该是独立机制

复杂系统不能把“有没有能力做这件事”留给模型从 prompt 自己猜。

更合理的机制是分开维护：

1. tool availability
2. connector authorization
3. API readiness
4. installed skills

然后再把这些状态压成简洁 overlay 注入 prompt 和 worker policy。

### 2.12 artifact 和 scheduled capsule 是长期运行的关键

长任务不应该只靠聊天记录维持连续性。

更稳定的做法是把两类对象做成一等公民：

1. artifact digest
2. scheduled prompt capsule

前者承载已经完成的中间产物，后者承载未来要自动回流的任务。

### 2.13 API 诊断要分层，而不是统一报错

对真实业务系统的执行不应只返回“调用失败”。

至少应区分：

1. credential invalid
2. credential valid but scope missing
3. schema mismatch
4. transport unavailable
5. business mutation failure

这会直接影响 recovery policy、fallback 顺序和用户提示质量。

---

## 3. 仍需继续深挖的关键问题

下面这些不是“可选优化”，而是决定系统是否能长期工作的核心问题。

### 3.1 Prompt layering 的精细边界

还需要继续明确：

1. 哪些内容属于角色长期 bundle
2. 哪些内容属于 team runtime 注入
3. 哪些内容属于 task overlay
4. 哪些内容属于 worker-local instruction
5. 哪些内容必须严格版本化

### 3.2 Memory retrieval 与注入策略

目前最缺的不是 memory 文件，而是：

1. 检索触发条件
2. 检索粒度
3. 注入位置
4. 对输出的影响范围
5. 与短期上下文的合并策略

### 3.3 上下文压缩策略

仍需明确：

1. 什么时候触发压缩
2. 压缩谁
3. 谁来压缩
4. 压缩后如何回填
5. 如何避免 summary 污染后续推理

### 3.4 任务 runtime 的真实边界

还需要继续设计：

1. task 是 role-local 还是 flow-global
2. verification step 如何表达
3. subtask 与 handoff 的关系
4. task 状态和 message/time line 的对齐方式

### 3.5 worker session 的热恢复与冷恢复

目前已知 session reuse 很重要，但还要明确：

1. 热恢复依赖哪些内存态
2. 冷恢复需要哪些磁盘态
3. 哪些 worker 允许 cold resume
4. 浏览器 session 恢复是否必须依赖 profile

### 3.6 权限模型

仍需明确：

1. browser permission
2. file write permission
3. network permission
4. delegated permission propagation
5. permission denial 后的 fallback 路线

### 3.7 并行 handoff 的循环边界

还要继续搞清楚：

1. re-entry 限制
2. iteration cap
3. per-role hop cap
4. flow-global hop cap
5. mention dedupe
6. 并行窗口合并

### 3.8 artifact 生命周期

仍需明确：

1. screenshot
2. structured extraction result
3. console result
4. worker replay
5. 哪些进 message，哪些只留 artifact store

### 3.9 browser profile 的 ownership

后续必须定清：

1. profile 属于 user、thread、role 还是 worker session
2. profile 如何隔离
3. profile 如何清理
4. 登录态如何复用而不串任务

### 3.10 结构化 worker 协议

目前最缺的是：

1. resume
2. interrupt
3. cancel
4. partial result
5. artifact emission
6. step trace emission

---

## 4. 对新系统的直接影响

基于上面的洞察，后续系统设计至少要补齐这 4 个文档面：

1. browser session / worker protocol
2. prompt stack design
3. context & compression design
4. recovery / QC policy design

这 4 套文档不清楚，后面的代码都只是局部实现。

---

## 5. 现阶段的结论

当前最稳的判断是：

1. 我们已经看清了主链
2. 但真正决定成败的是主链两侧的隐藏机制
3. 其中最关键的 3 个难点仍然是：
   - context compression
   - worker session lifecycle
   - browser session ownership

所以现在最合理的动作，不是立刻继续堆功能，而是先把这 3 套机制设计补齐。
