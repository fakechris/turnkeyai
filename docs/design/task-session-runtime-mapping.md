# Task Session Runtime Mapping

> 更新日期：2026-03-30  
> 目标：把当前实现里已经存在的 store、payload、replay 字段映射到 `TaskGraph / SessionGraph / DispatchEnvelope`，为后续收敛提供落点。

## 1. 这份文档解决什么问题

在 [Task Session Runtime Model](./task-session-runtime-model.md) 里，我们已经确定当前最值得外抽的三类模型是：

1. `TaskGraph`
2. `SessionGraph`
3. `DispatchEnvelope`

但那份文档只回答“为什么值得抽”和“应该抽什么”。  
这份文档继续回答：

1. 当前代码里，哪些字段已经属于这三类模型
2. 哪些字段仍然混杂在实现细节里
3. 后续如果要收敛，应该先从哪里动手

这份文档仍然不要求立刻改代码。

## 2. 总体判断

当前代码库已经有不少“隐式模型”：

- `FlowLedger` 已经承担了不少 `TaskGraph` 职责
- browser / worker / recovery 已经承担了不少 `SessionGraph` 职责
- `RelayPayload`、scheduled capsule、browser hint 已经承担了不少 `DispatchEnvelope` 职责

问题不是“没有模型”，而是：

- 同一个语义散在多个对象里
- 某些字段跨层混入
- replay / store / payload 的边界还不够干净

## 3. TaskGraph 映射

### 当前已有对象

当前最接近 `TaskGraph` 的实现对象是：

- `FlowLedger`
- `HandoffEdge`
- `ShardGroupRecord`
- `FanOutMergeContext`
- `ReplayIncidentBundle` 中的 grouped failure / follow-up 视图

### 当前对应关系

`TaskGraph / WorkItem`
- 当前主要落在：
  - `HandoffEnvelope.taskId`
  - `FlowLedger.rootMessageId`
  - `ScheduledTaskRecord.taskId`

`TaskGraph / Edge`
- 当前主要落在：
  - `FlowLedger.edges`
  - `HandoffEdge.state`

`TaskGraph / ShardGroup`
- 当前主要落在：
  - `FlowLedger.shardGroups`
  - `ShardGroupRecord.shardResults`

`TaskGraph / MergeGate`
- 当前主要落在：
  - `FanOutMergeContext`
  - `ParallelOrchestrationContext.kind = "merge_synthesis"`

`TaskGraph / RecoveryBranch`
- 当前主要落在：
  - `RecoveryRun.sourceGroupId`
  - replay bundle 里的 follow-up groups / recovery workflow linkage

### 当前混杂点

`TaskGraph` 语义现在分散在三层：

1. 运行时主对象：
   - `FlowLedger`
2. 派发 payload：
   - `mergeContext`
   - `parallelContext`
3. 事后观测：
   - replay bundle
   - recovery bundle

这意味着：

- merge readiness 既存在于 flow，又存在于 payload，又存在于 replay
- recovery branch 既像 task 关系，又像 recovery runtime 关系

### 当前建议

短期内先不重构，只明确：

1. `FlowLedger + HandoffEdge + ShardGroupRecord` 是 `TaskGraph` 的主落点
2. `mergeContext / parallelContext` 是 `TaskGraph` 的派发投影
3. replay bundle 是 `TaskGraph` 的观测投影

## 4. SessionGraph 映射

### 当前已有对象

当前最接近 `SessionGraph` 的实现对象是：

- `RoleRunState`
- worker runtime session state
- `BrowserSession`
- `BrowserTarget`
- `RecoveryRun`
- scheduled continuation state

### 当前对应关系

`SessionGraph / WorkSession`
- 当前主要落在：
  - `RoleRunState`

`SessionGraph / SubSession`
- 当前主要落在：
  - worker runtime 内的 session state
  - `RoleRunState.workerSessions`

`SessionGraph / BrowserSession`
- 当前主要落在：
  - `BrowserSession`
  - `BrowserTarget`
  - browser session / target stores

`SessionGraph / RecoveryRun`
- 当前主要落在：
  - `RecoveryRun`
  - `RecoveryRunAttempt`

`SessionGraph / ContinuationContext`
- 当前主要落在：
  - `RelayPayload.continuationContext`
  - `ScheduledTaskRecord.recoveryContext`
  - browser continuation hint
  - worker resume hints

### 当前混杂点

`SessionGraph` 语义现在最明显的重复有三类：

1. ownership / lease
   - browser session / target
   - worker continuity
   - scheduled re-entry

2. continuation
   - role-level continuity
   - worker resume
   - browser resume
   - recovery dispatch

3. parent/child/recovered-from
   - role run 与 worker session
   - incident bundle 与 recovery run
   - scheduled task 与 continuation context

### 当前建议

短期内先明确：

1. `RoleRunState` 是主会话
2. worker session / browser session / recovery run 都是 `SessionGraph` 的派生节点
3. `continuationContext` 是 `SessionGraph` 的统一投影入口

这意味着后续如果要收敛，优先应该从 `continuationContext` 和 `workerSessions / browserSession / recoveryRun` 关系入手，而不是先大改 flow。

## 5. DispatchEnvelope 映射

### 当前已有对象

当前最接近 `DispatchEnvelope` 的实现对象是：

- `HandoffEnvelope`
- `RelayPayload`
- `ScheduledTaskRecord`
- browser worker task packet
- worker prompt packet 中的 preferred worker / continuity hints

### 当前对应关系

`DispatchEnvelope / target`
- 当前主要落在：
  - `HandoffEnvelope.targetRoleId`
  - `ScheduledTaskRecord.targetRoleId`
  - `ScheduledTaskRecord.targetWorker`
  - browser session hint 内的 `sessionId / targetId`

`DispatchEnvelope / intent`
- 当前主要落在：
  - `activationType`
  - `instructions`
  - scheduled capsule
  - recovery action

`DispatchEnvelope / continuity`
- 当前主要落在：
  - `sessionTarget`
  - `preferredWorkerKinds`
  - `continuationContext`
  - worker continuity mode
  - browser resume mode

`DispatchEnvelope / constraints`
- 当前主要落在：
  - `dispatchPolicy`
  - capability readiness
  - governance / permission outcome

`DispatchEnvelope / mergeContext`
- 当前主要落在：
  - `mergeContext`
  - `parallelContext`

`DispatchEnvelope / recoveryContext`
- 当前主要落在：
  - `continuationContext.recovery`
  - `ScheduledTaskRecord.recoveryContext`

### 当前混杂点

现在最明显的问题是：

1. `RelayPayload` 承载了太多层的语义
2. scheduled task 自己也带一套调度字段
3. browser continuation hint 和 worker resume hint 还是特化片段，不是统一 envelope

这意味着后面如果继续加 transport / approval / retry / fallback，很容易继续膨胀。

### 当前建议

短期内先把 `HandoffEnvelope + RelayPayload` 视为 `DispatchEnvelope` 的当前实现主体，其他入口都视为它的特化版本。

这样后续如果需要真收敛，第一步不一定是改 runtime，而可能只是先做：

- `DispatchEnvelope` 的显式 schema
- `ScheduledTaskRecord -> DispatchEnvelope`
- `browser hint -> DispatchEnvelope.continuity`

## 6. 哪些字段现在最值得优先收敛

如果只挑最容易继续扩散的字段，我建议优先关注这几类：

### A. continuation fields

- `sessionTarget`
- `preferredWorkerKinds`
- `continuationContext`
- worker continuity mode
- browser `resumeMode`

### B. merge / follow-up fields

- `fanOutGroupId`
- `mergeContext`
- `parallelContext`
- `followUpRequired`
- coverage / duplicate / conflict 集合

### C. recovery linkage fields

- `recoveryRunId`
- `attemptId`
- `sourceGroupId`
- `dispatchReplayId`
- `nextAction`

### D. ownership / lease fields

- `ownerType`
- `ownerId`
- `leaseHolderRunKey`
- `leaseExpiresAt`

这些字段已经明显跨多个模块重复出现，是后续最容易优先纳入统一模型的部分。

## 7. 哪些地方暂时不要急着动

当前不建议优先动这些：

- `FlowLedgerStore` 的持久化格式
- browser store 的磁盘 schema
- replay recorder 的底层落盘结构
- prompt assembler / context stores 的现有文件结构

原因是：

1. 这些都已经承担了稳定功能
2. 当前问题主要是概念收敛，不是底层存储失效
3. 过早动存储层会让 Phase 1 收尾成本过高

## 8. 后续如果要开始真收敛，建议顺序

如果 Phase 1 收尾后，要开始把这些模型从文档推进到实现，我建议按下面顺序：

1. 先统一 `DispatchEnvelope` schema
2. 再统一 `ContinuationContext` 与 `RecoveryContext`
3. 再把 `RoleRunState / worker session / browser session / recovery run` 关系收进 `SessionGraph`
4. 最后再整理 `FlowLedger / shard group / merge gate / recovery branch` 作为 `TaskGraph`

这个顺序的原因是：

- payload 统一的成本最低
- session 语义当前最重复
- task graph 牵涉 flow/replay/recovery 三层，最后做更稳

## 9. 一句话结论

当前代码库已经不是“缺少模型”，而是：

> `TaskGraph / SessionGraph / DispatchEnvelope` 的语义已经存在，但分散在多个对象、payload 和观测层里。

所以后续真正要做的，不是凭空发明新抽象，而是把已经存在且重复的语义，逐步收回到这三类模型上。
