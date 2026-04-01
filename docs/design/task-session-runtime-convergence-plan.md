# Task Session Runtime Convergence Plan

> 更新日期：2026-03-30  
> 目标：给 `TaskGraph / SessionGraph / DispatchEnvelope` 的后续收敛提供一个可执行顺序，明确先收什么、后收什么、哪些暂时不要碰。

## 1. 这份文档解决什么问题

前两份文档已经回答了：

- [Task Session Runtime Model](./task-session-runtime-model.md)
  哪些语义已经重复到值得抽象
- [Task Session Runtime Mapping](./task-session-runtime-mapping.md)
  当前代码里的 store / payload / replay 字段分别落在哪些模型上

但还缺最后一个问题：

> 如果以后真开始把这些模型从“文档概念”推进到“实现收敛”，应该按什么顺序做，才能避免大面积返工。

这份文档只回答这个问题。

## 2. 总体原则

收敛顺序必须遵守三个原则：

1. **先统一投影，再统一内核**
   先收敛 payload / replay / surface，再收敛 store / runtime 主对象。

2. **先收最重复的语义，再收最深的结构**
   先收 `continuation / recovery / merge / ownership` 这些已经重复最多的字段，再碰 flow/session 的主存储结构。

3. **先收不会打断 Phase 1 的部分**
   只要某个收敛会直接打断当前可跑主链，就应该后移到第二期。

## 3. 建议的收敛顺序

### Step 1. 收敛 `DispatchEnvelope` schema

这是最值得先动的一步，因为：

- 成本最低
- 当前重复最多
- 对实现侵入最小

目标：

1. 明确一个稳定的 `DispatchEnvelope` 顶层 schema
2. 统一以下语义的命名和边界：
   - `target`
   - `intent`
   - `continuity`
   - `constraints`
   - `mergeContext`
   - `recoveryContext`
   - `capabilityContext`

当前优先收敛的字段：

- `sessionTarget`
- `preferredWorkerKinds`
- `continuationContext`
- `mergeContext`
- `parallelContext`
- `dispatchPolicy`
- `ScheduledTaskRecord.recoveryContext`

这一步不要求立刻删除旧字段，但要求：

1. 新增显式 schema
2. 给现有入口建立映射
3. 让后续新增字段必须先挂到这个 schema 上思考

### Step 2. 统一 `ContinuationContext`

`ContinuationContext` 是当前最重复的横切语义，因此应该在 `DispatchEnvelope` 之后单独收一次。

目标：

1. 把 role continuation、worker resume、browser resume、recovery dispatch、scheduled re-entry 的最小共同字段统一
2. 明确 continuation 的来源、级别和优先级

建议最先统一的子字段：

- `source`
- `workerType`
- `workerRunKey`
- `summary`
- `recovery`
- `browserSession`

这一步的重点不是“做更多 continuation”，而是避免继续长出新的 continuation 变体。

### Step 3. 收敛 `RecoveryContext`

在当前代码里，`RecoveryRun` 已经是一等对象了，所以 recovery 不应该再长期依赖零散字段维持关联。

目标：

1. 明确 recovery linkage 的唯一主键与最小字段集
2. 减少 replay / scheduled / continuation 三层里重复携带的 recovery 字段

优先关注这些字段：

- `recoveryRunId`
- `attemptId`
- `sourceGroupId`
- `dispatchReplayId`
- `nextAction`

这一步的预期结果是：

- recovery linkage 有一个明确主来源
- 其它层都尽量只引用，而不是重新拷贝业务语义

### Step 4. 收敛 `SessionGraph`

只有在 `DispatchEnvelope + ContinuationContext + RecoveryContext` 稳下来之后，才建议开始真正收 `SessionGraph`。

目标：

1. 明确主 session 和派生 session 的对象关系
2. 明确 parent / child / resumed-from / recovered-from / owned-by 这些关系

优先纳入的对象：

- `RoleRunState`
- worker session state
- `BrowserSession`
- `BrowserTarget`
- `RecoveryRun`

这一层开始之后，才值得考虑：

- `SessionGraph` projection
- session lineage
- 统一 session id / parent id / owner id 的可观测性

### Step 5. 最后再收 `TaskGraph`

`TaskGraph` 很重要，但不应该最先动。

原因：

- 它最深
- 同时牵涉 flow、merge、recovery、replay
- 一旦先动，很容易把 Phase 1 稳定主链打散

建议最后才统一这些：

- `WorkItem`
- `ShardGroup`
- `MergeGate`
- `FollowUpEdge`
- `RecoveryBranch`

并明确：

- flow store 是主投影
- merge/replay 是观测投影
- recovery branch 是 task 关系，不只是 recovery runtime 关系

## 4. 哪些 store 现在不要动

当前不建议优先动：

- `FlowLedgerStore`
- `BrowserSessionStore`
- `BrowserTargetStore`
- replay recorder 的落盘结构
- thread summary / memory / journal / scratchpad 的文件 schema

原因：

1. 这些 store 现在已经稳定支撑主链
2. 当前问题是语义收敛，不是存储失效
3. 过早动它们，成本会明显高于收益

## 5. 哪些 surface 可以先开始贴近模型

虽然现在不建议大改实现，但有些外层 surface 可以提前对齐模型。

建议优先对齐的 surface：

1. replay / incident / bundle
2. governance query
3. browser session inspection
4. scheduled task inspection

原因是：

- 这些本来就是投影层
- 改它们比改 store 成本更低
- 更适合作为三类模型的“可见形态”

## 6. 每一步的验收问题

### DispatchEnvelope 收敛完成后，应能回答：

1. 一次派发到底带了哪些稳定字段
2. scheduled / worker / browser / recovery 的 dispatch 是否能用同一组术语解释

### ContinuationContext 收敛完成后，应能回答：

1. 当前是从哪里继续
2. 继续依赖的是 role、worker、browser 还是 recovery
3. continuation packet 的优先级和来源是否清楚

### RecoveryContext 收敛完成后，应能回答：

1. 某次恢复尝试属于哪个 recovery run
2. 某条 replay / bundle / scheduled dispatch 为什么会挂到这条恢复链上

### SessionGraph 收敛完成后，应能回答：

1. 当前有哪些执行上下文是主 session
2. 哪些是派生 sub-session
3. 某次 resume / recover / re-entry 是沿着哪条 session lineage 发生的

### TaskGraph 收敛完成后，应能回答：

1. 当前 work item 是怎么被切分、合流和恢复的
2. merge gate 与 recovery branch 是否都能用统一图关系解释

## 7. 和第二期的关系

这份收敛顺序不是独立 roadmap，而是第二期 kernel lift 的前置约束。

更具体地说：

- `DispatchEnvelope` 会直接影响 typed delegation / work package
- `SessionGraph` 会直接影响 durable execution journal
- `TaskGraph` 会直接影响 merge gate / recovery branch / work package lineage

所以，这份文档的意义不是“再加一个设计文档”，而是：

> 让第二期真正开始时，不需要临时决定从哪里下刀。

## 8. 一句话结论

如果以后要开始把 `TaskGraph / SessionGraph / DispatchEnvelope` 从概念推进到实现，最稳的顺序是：

1. `DispatchEnvelope`
2. `ContinuationContext`
3. `RecoveryContext`
4. `SessionGraph`
5. `TaskGraph`

也就是说：

> 先收派发语义，再收继续语义，再收恢复关系，然后才收会话图和任务图。
