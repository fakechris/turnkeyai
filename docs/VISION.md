# Vision

## 愿景

TurnkeyAI 的长期目标，是成为一个本地优先的 Agent Workbench。

它不是把单个大模型包装成一个聊天窗口，而是把一整套协作运行机制做成可以持续工作的系统：

- 人和 Team 协作
- Role 之间 handoff
- Role 派生 Worker
- Worker 驱动 browser / tool / API / scheduled task
- 全链路可持久化、可恢复、可审计

## 我们想解决的问题

今天的大多数 Agent 产品，常见问题是：

- 能力很多，但执行不稳定
- 会话很强，但长任务会漂
- browser 能跑，但状态不容易复用
- worker 存在，但没有统一生命周期
- prompt 很多，但 context 不可控

TurnkeyAI 的目标不是“再包一层模型”，而是把这些关键运行机制做扎实。

## 我们想构建的系统

长期来看，这个项目会收敛成 5 个核心层：

1. Team Runtime  
负责线程、handoff、flow、role activation。

2. Role Runtime  
负责 prompt 组装、模型选择、上下文视图和角色执行。

3. Worker Runtime  
负责 browser / explore / finance / coder 等子执行体的统一生命周期。

4. Browser Runtime  
负责 session、target、profile、artifact、resume 和 transport hierarchy。

5. Quality Runtime  
负责 replay、diagnosis、verification、evaluation 和 recovery。

## 产品形态

最终产品形态会是一个桌面工作台。

但在研发路径上，我们会坚持：

- 先 daemon / runtime
- 再 TUI / debugging surface
- 最后再做 Electron GUI

原因很直接：如果 runtime 核心不稳，GUI 只会放大问题。

## 设计原则

### 1. Local-first

执行状态、artifact、session、trace 应优先保存在本地。

### 2. Runtime-first

先把运行机制做稳，再谈 UI 包装。

### 3. Session-aware

无论是 role、worker 还是 browser，都不能只做“一次性调用”，必须有 session 语义。

### 4. Auditable

关键动作应该可追溯、可复盘、可诊断。

### 5. Composable

Role、Worker、Tool、Transport、Memory 都应该可以替换和组合。

## 长期成功标准

如果未来判断这个项目是否成功，我会看 5 件事：

1. 能否稳定运行多角色协作，而不是只跑单轮 demo
2. 能否让 browser / worker / scheduled task 长期复用状态
3. 能否把 context 和 memory 管理做成可控系统
4. 能否把 replay / diagnosis 做成真正的调试基础设施
5. 能否在桌面形态下仍保持 runtime 架构清晰

## 当前阶段的现实目标

当前阶段不是去追求“功能全”，而是优先把下面三条主轴做稳：

1. Browser Runtime
2. General Subagent Runtime
3. Context / Memory Runtime

这是把系统从“可以跑”推进到“可以长期工作”的关键。
