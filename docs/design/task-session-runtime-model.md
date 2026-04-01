# Task Session Runtime Model

> 更新日期：2026-03-30  
> 目标：在不改实现的前提下，先收敛当前 runtime 中已经重复出现、且足够稳定的对象与语义。

## 1. 为什么现在要做这份文档

当前系统已经具备：

- team / role / worker / browser 的主链运行时
- fan-out / merge gate / follow-up
- scheduled re-entry / continuation
- replay / incident / bundle / recovery run
- browser session / target / ownership / lease

这些能力已经不再是单点实验，而是开始在多个主链里反复出现。

现在的问题不是“缺功能”，而是：

1. 相同语义开始在不同模块里重复表达
2. continuation / merge / recovery / ownership 的 payload 越来越散
3. 后续如果继续推进 durable execution、context compiler、policy kernel，这些重复语义会变成负担

所以这份文档不是为了发明一个更大的系统，而是为了回答一个更克制的问题：

> 哪些语义已经重复到值得抽成显式模型，哪些还不值得。

## 2. 判断标准

只有同时满足下面两个条件的东西，才值得外抽：

1. 它已经覆盖至少两条现有主链
2. 它一旦不统一，后续会继续在 payload、store、replay 或 runtime 分支里膨胀

换句话说，这份文档不是为了“优雅”，而是为了减少未来的扩散成本。

## 3. 当前最值得收敛的三类模型

### 3.1 TaskGraph

`TaskGraph` 回答的问题是：

> 现在有哪些工作单元，它们之间是什么关系。

它不是传统意义上的“任务列表”，而是当前系统里这些结构的统一视图：

- flow
- handoff edge
- shard group
- merge gate
- follow-up edge
- recovery branch

当前已经重复出现的语义：

- 某个工作单元属于哪一组 shard
- 哪些 shard 还没覆盖
- 哪些结果冲突或重复
- 何时允许 merge back
- 哪条恢复链是从哪个失败点分出来的

因此，`TaskGraph` 应该至少包含下面这些对象：

- `WorkItem`
- `ShardGroup`
- `MergeGate`
- `FollowUpEdge`
- `RecoveryBranch`

当前不需要把它做成：

- 通用项目管理系统
- 自由层级 team-of-teams 图
- 任意复杂 DAG 编辑器

它的第一职责，只是让当前已有的 flow / shard / merge / recovery 关系变得显式。

### 3.2 SessionGraph

`SessionGraph` 回答的问题是：

> 现在有哪些执行上下文还活着，它们之间怎么继续、恢复、派生。

这是当前最值得外抽的一层，因为它已经同时覆盖：

- role continuity
- worker session continuity
- browser session continuity
- scheduled re-entry
- recovery run continuation

它应该统一描述下面这些对象：

- `WorkSession`
- `SubSession`
- `BrowserSession`
- `RecoveryRun`
- `ContinuationContext`

它们之间至少有这些关系：

- parent / child
- resumed-from
- recovered-from
- attached-to
- owned-by

这里最重要的不是“把所有 session 合成一个类”，而是明确：

1. 哪些 session 是主执行上下文
2. 哪些 session 是派生支路
3. continuation 发生时是复用、恢复、重建，还是转入 recovery

当前不需要把 `SessionGraph` 做成：

- 通用 actor model
- 完整分布式调度器
- 跨机器的 cluster runtime

它的第一职责，只是让现有的 spawn / send / resume / re-entry / recovery 语义落到同一个对象模型里。

### 3.3 DispatchEnvelope

`DispatchEnvelope` 回答的问题是：

> 一次派发或继续执行，到底携带了哪些最小必要信息。

当前系统里已经存在多种相似 payload：

- role handoff payload
- worker spawn packet
- worker resume hint
- scheduled capsule
- recovery dispatch context
- browser continuation hint

这些 payload 的共同语义已经足够明显：

- 目标是谁
- 为什么派发
- 这次是 fresh / continue / recover 哪一种
- 携带了哪些 continuation / merge / governance 约束
- 后续应回到哪里

因此，`DispatchEnvelope` 应该至少统一下面这些字段：

- `target`
- `intent`
- `continuity`
- `constraints`
- `mergeContext`
- `recoveryContext`
- `capabilityContext`

它的职责不是取代所有现有 packet，而是定义一个稳定的上层 contract，让不同 runtime 入口不再各自扩张。

## 4. 为什么不是先抽 TeamSystem

当前不建议优先把外层抽象成统一的 `TeamSystem`，原因很简单：

1. team 只是当前运行时的一层，不是所有问题的中心
2. browser continuity、recovery run、scheduled re-entry 并不天然属于 team 语义
3. 现在更重复的不是“team 成员关系”，而是任务关系、会话关系和派发 payload

所以，当前更合理的外层模型不是：

- `Team -> Inbox -> TaskList`

而是：

- `TaskGraph`
- `SessionGraph`
- `DispatchEnvelope`

这三者能同时覆盖单聊、多角色、worker、browser、scheduled 和 recovery 这些主链。

## 5. 什么已经值得外抽

下面这些语义已经重复到值得收敛：

- `continuation`
- `merge coverage`
- `follow-up required`
- `ownership / lease`
- `resume mode`
- `recovery phase`
- `transport mode`
- `trust level`
- `prompt admission outcome`

这些语义目前分散在：

- prompt packet
- worker payload
- browser continuation hint
- replay metadata
- recovery bundle
- governance event

继续维持分散状态，会让后续 durable execution 和 context compiler 更难推进。

## 6. 什么现在还不值得外抽

下面这些现在先不要抽：

- 通用 `AgentOS`
- 自由组网的 team-of-teams
- 通用 mailbox protocol
- 全局统一 policy engine
- 完整 context compiler v2
- 跨进程 / 跨机器调度抽象

原因不是它们永远不需要，而是：

1. 当前还没有足够稳定的需求边界
2. 过早抽象会把 Phase 1 的产品化收尾打断
3. 这些更适合进入第二期 kernel lift 再统一处理

## 7. 这份模型对现有代码的意义

这份文档不会立刻要求改代码。

它的作用是给后续重构和收敛提供判断标准：

1. 新增 runtime 能力时，优先挂到 `TaskGraph / SessionGraph / DispatchEnvelope` 三类模型上思考
2. 当同一语义在第三处开始重复时，就应该考虑是否并入这三类模型
3. Phase 2 的 durable execution / context compiler / policy kernel，应以这三类模型为收敛方向

## 8. 当前建议的推进方式

短期内只做三件事：

1. 用这份文档统一术语
2. 在后续设计讨论里，优先用 `TaskGraph / SessionGraph / DispatchEnvelope` 来判断是否值得抽象
3. 等 Phase 1 收尾稳定后，再决定哪些现有 store / payload / replay 字段要正式迁移到这些模型

## 9. 一句话结论

当前最值得外抽的，不是一个更大的 `TeamSystem`，而是三个更贴近现有主链的模型：

- `TaskGraph`
- `SessionGraph`
- `DispatchEnvelope`

因为真正已经重复到会继续扩散的，不是“team”这个词，而是：

- 工作单元如何分裂与合流
- 执行上下文如何继续与恢复
- 一次派发到底携带了哪些稳定语义
