# TurnkeyAI

本项目的目标，是构建一套本地优先、可扩展、可审计的协作式 Agent Runtime。

它不是单一的聊天应用，也不是单一的 browser automation demo。它更像一个逐步成型的本地 Agent Workbench：支持 Team、Role、Worker、Browser Runtime、Prompt/Context 管理，以及后续的桌面端壳层。

## 当前状态

当前仓库已经完成 `Phase 1 / Production Hardening` 的核心机制建设，并进入同场景 end-to-end 验收与长期稳态验证阶段。

已经具备：

- 本地 `daemon + TUI` 调试入口
- Team / Flow / Role Run 基础运行时
- 多模型 adapter 抽象
- Browser session / target / artifact / ref 的基础持久化
- Browser Runtime v2 的 session/target 控制面
- Worker `spawn / send / resume / interrupt / cancel`
- `browser / explore / finance` 三类 worker
- 受控并行的 sub-session / worker fan-out 基础能力
- Prompt assembly / context budgeting / summary / scratchpad 第一版
- layered thread memory / journal / scratchpad / summary 持久化边界
- Scheduled task runtime 与 re-entry capsule 第一版
- structured continuation context 与 role-level continuity 第一版
- QC / replay / API diagnosis 第一版
- role / worker / browser / scheduled 主链 replay
- governance surface: permission cache / audit / replay 查询
- flow / governance operator summary 与更可读的 TUI 视图
- operator summary / operator attention / replay bundle 的统一 case 语义与首页级摘要
- replay summary / incident / grouped inspection / recovery dispatch / console / workflow-log surface
- recovery-linked incident bundles 与 recovery workflow 状态汇总
- RecoveryRun / attempt 持久化与 `approve / reject / retry / fallback / resume` action surface
- RecoveryRun event log / merged timeline / progress / phase / causality chain
- browser-specific recovery outcome 与 repeated retry/fallback escalation policy
- browser 显式 session protocol：`spawn / send / history / resume`
- Recovery runtime v2：attempt causality / event timeline / operator surface / recovery chain
- bounded regression harness 与 browser reliability soak 样本扩充
- Browser Runtime v2.6 的 ownership-aware re-entry
- browser `hot / warm / cold` resume 与 target-local snapshot/ref history
- retrieval ranking / recall trigger / budget-aware prompt packing / tool-result pruning / long-running compression 第一版
- prompt assembly compact-before-drop 与 `compactedSegments` 元数据
- browser continuity matrix：lease reclaim / wrong-owner denial / reopen/new-target 长链验证
- recovery timeline / bundle / TUI 工单视图与 phase/gate 对齐
- context carry-forward：pending/waiting recall 优先级与 unresolved question memory carry-forward
- browser continuity 已进入 replay bundle / console / TUI 视图
- recent-turn salience packing 与 browser/recovery bounded regression case 继续扩充
- bounded regression harness 已覆盖 browser / recovery / context / parallel / governance 五类主线样本
- operator-facing case cards：`active / resolved recent`、`headline / latestUpdate / nextStep`
- cross-surface operator attention：`caseState / severity / lifecycle / caseKey / browser continuity`
- context runtime tuning：approval / merge / continuation 的语义 recall 与 salience compaction

还没有具备：

- 通用 subagent runtime v2
- durable execution 级别的 subagent kernel
- context / memory / compression v2 的完整 compiler 形态
- 更大规模、长期运行下的 real-world soak 结论
- 更完整的 real-world acceptance / evaluation harness
- Electron GUI

一句话判断：

- 核心执行内核：已经基本成熟
- 产品级协作桌面：还没到

## 当前优先级

现在最重要的不是继续补新的 runtime 机制，也不是立刻进入 Phase 2，而是把现有主线压到同场景 end-to-end 验收和长期稳态。

接下来的优先级明确分成两期：

### Phase 1: Production Hardening

1. prompt / memory / compaction 稳定化
2. sub-session / continue / re-entry / timeout summarize
3. 并行 sub-agent orchestration / fan-out / merge-synthesis 稳定化
4. tool registry / permission / audit / transport hierarchy
5. browser session / target / ownership / reconnect
6. replay / failure analysis 第一层产品化

### Phase 2: Runtime Kernel Lift

1. durable execution journal / worker envelope
2. context compiler / memory hierarchy / cache taxonomy
3. tool policy kernel
4. typed delegation / work package / merge gate
5. 更完整的 replay / eval / trace

先把第一期这些生产优化主线做稳，再推进第二期的 kernel 化，成本会低很多。

当前状态：

- `Phase 1 / Production Hardening` 的核心机制已完成
- runtime hard-points parity 的五个 pack 已完成：
  - session continuity
  - progress event
  - large-output governance
  - memory / compact discipline
  - uploader / backpressure
- `Runtime Observability v1.x` 已进主线，并覆盖 `flow / replay / recovery / live role/worker/browser`
- bounded regression、browser soak、runtime/operator acceptance 已覆盖 browser / recovery / context / parallel / governance / runtime 主线
- 当前主线转为：
  - 同场景 end-to-end 验收
  - 长链 soak
  - failure injection
  - real-world validation

## 快速开始

```bash
npm install
npm run typecheck
npm test
```

当前仓库与公开 CLI 包统一要求 `Node.js 24+`。

主干 PR 的基础 CI 当前会运行 `npm run typecheck`、`npm test` 和 `npm run build`。

启动本地 daemon：

```bash
npm run daemon
```

启动 TUI：

```bash
npm run tui
```

如果使用公开发布的 CLI 包：

```bash
npx @turnkeyai/cli daemon
```

另一个终端中连接 TUI：

```bash
npx @turnkeyai/cli tui
```

当前 daemon 主要提供：

- thread / message / flow 调试接口
- browser session / target 控制接口
- scheduled task 调试接口
- capability discovery 查询接口
- replay / recovery / regression 查询接口

## 仓库结构

主要 package：

- `packages/core-types`: shared contracts
- `packages/team-store`: file-backed stores
- `packages/team-runtime`: team / flow / scheduling runtime
- `packages/role-runtime`: prompt policy / context assembly / role execution
- `packages/worker-runtime`: worker registry / worker handlers
- `packages/browser-bridge`: browser session / target / bridge runtime
- `packages/llm-adapter`: multi-provider model adapters
- `packages/qc-runtime`: verification / diagnosis / replay helpers
- `packages/app-gateway`: local daemon entry
- `packages/tui`: terminal debug client

## 文档入口

- [Vision](./docs/VISION.md)
- [Milestones](./docs/MILESTONES.md)
- [Roadmap](./docs/design/roadmap.md)
- [Production Hardening Checklist](./docs/design/production-hardening-checklist.md)
- [Phase 1 Productization Matrix](./docs/design/phase1-productization-matrix.md)
- [Production Hardening Target State](./docs/design/production-hardening-target-state.md)
- [Production Hardening Gap Map](./docs/design/production-hardening-gap-map.md)
- [Task Session Runtime Model](./docs/design/task-session-runtime-model.md)
- [Task Session Runtime Mapping](./docs/design/task-session-runtime-mapping.md)
- [Task Session Runtime Convergence Plan](./docs/design/task-session-runtime-convergence-plan.md)
- [Runtime Core v2 Plan](./docs/design/runtime-core-v2-plan.md)
- [Project Foundation](./docs/design/project-foundation.md)
- [Browser Session And Worker Protocol](./docs/design/browser-session-and-worker-protocol.md)
- [Prompt Context Compression Design](./docs/design/prompt-context-compression-design.md)

## 当前里程碑判断

如果把目标定义为“本地可跑的多角色 runtime 骨架”，当前大致在：

- `95%+`

如果把目标定义为“可日常使用的协作式 agent 桌面工作台”，当前大致在：

- `70%`

剩余差距主要集中在：

- 更长链、更真实任务的 soak / acceptance 覆盖
- runtime/operator 在真实排障过程里的易用性继续打磨
- real-world failure injection 下的长期稳态
- GUI

## 开源阶段说明

当前项目仍处于内核快速演进阶段。

这意味着：

- 对外接口还会继续收敛
- 存储 schema 还会继续打磨
- 重点优先放在 runtime 稳定性，而不是 UI 完整度

如果你现在阅读这个仓库，最适合把它理解成：

- 一个正在成型的本地 Agent Runtime
- 而不是一个已经完整打磨好的桌面产品

## License

Apache-2.0. See [LICENSE](./LICENSE).
