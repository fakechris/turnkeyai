# TurnkeyAI

[![npm version](https://img.shields.io/npm/v/@turnkeyai/cli?label=%40turnkeyai%2Fcli)](https://www.npmjs.com/package/@turnkeyai/cli)
[![npm downloads](https://img.shields.io/npm/dm/@turnkeyai/cli)](https://www.npmjs.com/package/@turnkeyai/cli)

本项目的目标，是构建一套本地优先、可扩展、可审计的协作式 Agent Runtime。

它不是单一的聊天应用，也不是单一的 browser automation demo。它更像一个逐步成型的本地 Agent Workbench：支持 Team、Role、Worker、Browser Runtime、Prompt/Context 管理，以及后续的桌面端壳层。

## 当前状态

当前仓库已经完成 `Phase 1 / Production Hardening` 的核心机制建设。最近一轮已把 cross-store safety、canonical schema cleanup、browser transport sealing、reliability net、storage shape、worker durability 和 core type boundary cleanup 合入主线。

当前阶段不再是补核心机制，而是进入同场景 end-to-end 验收、长链 soak、failure injection 与 real-world validation。

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
- operator triage 首页级入口，可直接汇总 case / runtime / prompt 的排障优先级
- replay summary / incident / grouped inspection / recovery dispatch / console / workflow-log surface
- recovery-linked incident bundles 与 recovery workflow 状态汇总
- replay console 现同时暴露 actionable bundles 与 recent resolved bundles
- RecoveryRun / attempt 持久化与 `approve / reject / retry / fallback / resume` action surface
- RecoveryRun event log / merged timeline / progress / phase / causality chain
- browser-specific recovery outcome 与 repeated retry/fallback escalation policy
- browser 显式 session protocol：`spawn / send / history / resume`
- Recovery runtime v2：attempt causality / event timeline / operator surface / recovery chain
- bounded regression harness 与 browser reliability soak 样本扩充
- browser recovery validation 已覆盖 multi-attempt resume -> fallback -> cold reopen 长链
- Browser Runtime v2.6 的 ownership-aware re-entry
- browser `hot / warm / cold` resume 与 target-local snapshot/ref history
- retrieval ranking / recall trigger / budget-aware prompt packing / tool-result pruning / long-running compression 第一版
- prompt assembly compact-before-drop 与 `compactedSegments` 元数据
- browser continuity matrix：lease reclaim / wrong-owner denial / reopen/new-target 长链验证
- target-local snapshot/ref history 已覆盖同 URL 多 target 下的隔离与 reopen 后连续性验证
- browser eviction 边界已覆盖旧 session history/ref 保留与新 replacement session ref 隔离
- recovery timeline / bundle / TUI 工单视图与 phase/gate 对齐
- context carry-forward：pending/waiting recall 优先级与 unresolved question memory carry-forward
- browser continuity 已进入 replay bundle / console / TUI 视图
- recent-turn salience packing 与 browser/recovery bounded regression case 继续扩充
- bounded regression harness 已覆盖 browser / recovery / context / parallel / governance 五类主线样本
- operator-facing case cards：`active / resolved recent`、`headline / latestUpdate / nextStep`
- cross-surface operator attention：`caseState / severity / lifecycle / caseKey / browser continuity`
- context runtime tuning：approval / merge / continuation 的语义 recall 与 salience compaction
- context/runtime acceptance 已覆盖高压 compaction 下的 carry-forward、waiting-point 与 prompt-console 对齐
- failure/acceptance 现已覆盖 compound incident triage：browser manual follow-up、runtime waiting、prompt pressure 同页收敛
- real-world runbook suite 第一版已接入，覆盖 browser research、governed publish、parallel follow-up、runtime observability 等真实任务组合样本
- release readiness 已进入主线，可验证 packed CLI、bin smoke、dry-run publish 和 release artifact 元数据
- cross-store safety 第一版：ingress outbox、runtime-chain projection version/CAS、dropped/retry-exhausted replay incident 可见性
- canonical schema cleanup：RelayPayload / ScheduledTaskRecord 读路径已收敛到 canonical shape，legacy fallback 面继续缩小
- browser transport sealing：relay peer identity binding、browser route validation、relay/direct-cdp launch / wait / smoke / soak 链路已进主线
- truth alignment / remediation unification / stale marker / reliability net 已进入 replay、recovery、operator 查询面
- storage shape hardening：team message by-id projection、recovery run/event canonical projection 与 legacy repair gating 已进入 store 层
- worker durability：持久化 worker session 的 unrecoverable state 已能被 startup reconcile 与 operator 查询看到
- core type boundary cleanup：replay / recovery / operator / prompt / runtime support 类型边界已拆细

还没有具备：

- 通用 subagent runtime v2
- durable execution 级别的 worker/subagent kernel
- 事务级 WAL / outbox / cross-store commit protocol
- context / memory / compression v2 的完整 compiler 形态
- 更大规模、长期运行下的 browser bridge / relay / direct-cdp real-world soak 结论
- 更系统化的 real-world acceptance / evaluation harness
- Electron GUI

一句话判断：

- runtime/workbench backend：核心机制已经基本成熟，正在做产品化验收
- 产品级协作桌面：还没开始

## 当前优先级

现在最重要的不是继续补新的 runtime 机制，也不是立刻进入 Phase 2，而是把现有主线压到同场景 end-to-end 验收、真实 browser bridge/relay 长链、长期稳态和 operator 可诊断性。

接下来的优先级明确分成两期：

### Phase 1: Production Hardening

Phase 1 的机制主线已经完成。剩余工作按验收顺序推进：

1. browser bridge / relay / direct-cdp 长链真实任务验证
2. recovery / replay / operator surface 的 case 状态一致性和可读性收尾
3. context / memory / compaction 在高压预算和真实任务下继续调优
4. parallel orchestration / governance / permission / audit 的 contract 和 regression 扩充
5. real-world acceptance、failure injection、transport soak 持续扩样本

### Phase 2: Runtime Kernel Lift

1. durable execution journal / worker envelope
2. context compiler / memory hierarchy / cache taxonomy
3. tool policy kernel
4. typed delegation / work package / merge gate
5. 更完整的 replay / eval / trace

先把第一期这些生产优化主线做稳，再推进第二期的 kernel 化，成本会低很多。

当前状态：

- `Phase 1 / Production Hardening` 的核心机制已完成
- W3 / W6 / W8 / W10 / W4 / W2 / W5 系列 hardening 已合入主线
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
  - browser bridge / relay / direct-cdp 长链验证
  - 长链 soak
  - failure injection
  - real-world validation

## 快速开始

当前仓库与公开 CLI 包统一要求 `Node.js 24+`。

使用公开 npm CLI：

```bash
npx @turnkeyai/cli --help
npx @turnkeyai/cli daemon
```

另一个终端中连接 TUI：

```bash
npx @turnkeyai/cli tui
```

如果希望安装成全局命令：

```bash
npm install -g @turnkeyai/cli
turnkeyai daemon
turnkeyai tui
```

默认 daemon 地址：

```text
http://127.0.0.1:4100
```

常用环境变量：

- `TURNKEYAI_DAEMON_PORT`: 覆盖本地 daemon 监听端口
- `TURNKEYAI_DAEMON_URL`: 让 TUI / CLI 连接指定 daemon
- `TURNKEYAI_DAEMON_TOKEN`: 开启 daemon token auth 时使用的访问 token
- `TURNKEYAI_BROWSER_TRANSPORT`: 选择 `relay` 或 `direct-cdp` browser transport
- `TURNKEYAI_BROWSER_RELAY_TOKEN`: relay peer 使用的独立 token
- `TURNKEYAI_BROWSER_CDP_ENDPOINT`: direct-cdp transport 使用的 CDP endpoint

本地源码开发：

```bash
npm install
npm run typecheck
npm test
```

主干 PR 的基础 CI 当前会运行 `npm run typecheck`、`npm test` 和 `npm run build`。

本地源码运行 daemon / TUI：

```bash
npm run daemon
npm run tui
```

如果要构建 Chrome relay extension 产物：

```bash
npm run build:relay-extension
```

产物会输出到：

```text
packages/browser-relay-peer/dist/extension
```

当前这是未打包的 Chrome extension 目录，包含：

- `manifest.json`
- `service-worker.js`
- `content-script.js`

如果要直接启动一个带扩展的本地 Chromium 系浏览器做 smoke：

```bash
npm run relay:launch -- --url https://example.com
```

脚本当前会优先选择支持 unpacked extension flag 的本地浏览器；在 macOS 上，若正式版 `Google Chrome` 忽略这些 flag，优先改用 `Microsoft Edge`、`Chromium`，或显式传 `--chrome-path`。

如果 daemon 已经以 relay 模式启动，可以等待扩展 peer 真正注册上来：

```bash
npm run relay:wait -- --require-target
```

如果要启动一个带 `--remote-debugging-port` 的本地 Chromium 系浏览器做 direct-cdp 验证：

```bash
npm run cdp:launch -- --url https://example.com
```

如果已经有一个可用的 CDP endpoint，可以等待它真正 ready：

```bash
npm run cdp:wait -- --cdp-endpoint http://127.0.0.1:9222
```

如果要一条命令跑完整本地 direct-cdp smoke：

```bash
npm run cdp:smoke
npm run cdp:smoke -- --url https://example.com
npm run cdp:smoke -- --verify-reconnect --verify-workflow-log
```

如果要一条命令跑完整本地 smoke：

```bash
npm run relay:smoke
npm run relay:smoke -- --url https://example.com
```

如果只想验证“未打包扩展已安装、service worker 已唤醒、peer/target 已连回 daemon”，可以直接跑：

```bash
npm run relay:install-smoke
```

如果要把 relay / direct-cdp 的 reconnect 与 workflow-log 诊断做成持续 soak：

```bash
npm run transport:soak -- --cycles 3
npm run transport:soak -- --cycles 1 --targets relay
```

配合本地 daemon 走 relay transport 时，可以显式设置：

```bash
TURNKEYAI_BROWSER_TRANSPORT=relay npm run daemon
```

如果启用了分层 daemon auth，推荐给 browser relay peer 单独配置：

```bash
TURNKEYAI_BROWSER_RELAY_TOKEN=... TURNKEYAI_BROWSER_TRANSPORT=relay npm run daemon
```

配合本地 daemon 走 direct-cdp transport 时，可以显式设置：

```bash
TURNKEYAI_BROWSER_TRANSPORT=direct-cdp \
TURNKEYAI_BROWSER_CDP_ENDPOINT=http://127.0.0.1:9222 \
npm run daemon
```

当前 daemon 主要提供：

- thread / message / flow 调试接口
- browser session / target 控制接口
- scheduled task 调试接口
- capability discovery 查询接口
- replay / recovery / regression 查询接口

当前 TUI 也可以直接运行：

- bounded regression harness
- long-chain stability soak harness
- scenario parity acceptance harness
- failure injection harness
- unified validation catalog: `validation-cases` / `validation-run [suite[:item] ...]`
- fixed validation profiles: `validation-profiles` / `validation-profile-run <profileId>`
- operator-facing validation ops summary: `validation-ops [limit]`
- real-world runbook harness: `realworld-cases` / `realworld-run [scenarioId ...]`
- release readiness: `release-verify`
- multi-cycle soak series: `soak-series [cycles] [suite[:item] ...]`
- browser transport soak: `transport-soak [cycles] [relay|direct-cdp ...]`

对应命令包括：

- `soak-cases`
- `soak-run [scenarioId ...]`
- `soak-series 10 soak realworld acceptance`
- `release-verify`
- `transport-soak 3 relay direct-cdp`
- `npm run relay:install-smoke`
- `npm run transport:soak -- --cycles 3`
- `validation-ops`
- `validation-profiles`
- `validation-profile-run smoke`
- `validation-profile-run phase1-e2e`

`replay-console` 会同时显示仍需处理的 `latest bundles`，以及最近已收敛的 `latest resolved bundles`，便于把当前告警和刚恢复的 case 分开看；同时也会把 recovery operator 的 `case state`、`gate` 和 `allowed actions` 一起带出来，避免 workflow 已 recovered 但 operator 仍在 `waiting_manual` 时被首页级视图误判为彻底收口。
`replay-bundle` 现在会直接带出 recovery operator 语义，包括当前 `gate`、允许动作、phase summary 和最近一次 browser outcome，便于不翻源码直接判断这个 case 还卡在哪一步。
`operator-summary` / `operator-attention` 现在会把 recovery case 的 `allowed actions` 一起打出来，避免只看到 `next action` 却不知道当前 run 还允许哪些手动操作。
`operator-triage` 会把当前最该看的 incident、runtime waiting/stale 和 prompt pressure 聚到一页里，并给出对应的 console 命令入口。
`prompt-console` 现在会额外汇总 recent-turn / retrieved-memory / worker-evidence 的实际打包数量，以及 pending / waiting / open-question / decision-or-constraint 的 carry-forward 情况；acceptance / soak 也已把这些计数和 runtime waiting-point 一起编进长链验证，方便直接看高压上下文下哪些信息被保住了。
`release-verify` 会对将要公开发布的 CLI 走一遍 `npm pack`、解包、bin/dist help smoke 和 `npm publish --dry-run`，避免 package metadata 在真正发版时才暴露问题；`soak-series` 和单独的 `Long Soak` workflow 会把 `soak / realworld / acceptance` 做多轮聚合运行，用来承接高成本、非 PR required 的长周期稳态验证。
`validation-ops` 会把最近的 `validation-profile-run`、`release-verify` 和 `soak-series` 结果收成 operator-facing 读数，统一展示失败 bucket、推荐动作和重跑命令，避免验证失败只留在一次性 stdout 里。
`transport-soak` 现在也会进入同一套 `validation-ops` 记录，并带上 artifact 路径，方便值班时直接回看 relay/direct-cdp 的多 cycle 诊断结果。
`validation-profiles` / `validation-profile-run` 会把现有 `validation-run`、`release-verify`、`soak-series` 和 `transport-soak` 收成固定 hardening 档位：`smoke` 适合本地快速回归，`phase1-e2e` 固定覆盖 Phase 1 收尾的 browser/recovery/context/governance/operator 同场景验收，`nightly` / `prerelease` / `weekly` 会把 transport 连通性和多 cycle 稳定性也一起压过一遍，适合持续稳定性和值班/发版前信心检查。
`relay-peers` / `relay-targets [peerId]` 可以直接查看本地 daemon 当前看到的 relay 扩展连接和浏览器 tab 发现结果，便于做 extension smoke 和 transport 排障。
`relay:install-smoke` 会走一遍“build relay extension -> 启动本地 Chromium + unpacked extension -> 等 daemon 看见 peer/target”的真机安装连通链，适合快速确认本地浏览器端 bridge 没坏。
`transport:soak` 会重复跑 relay / direct-cdp 的真实 smoke，并把失败按 `peer-timeout / cdp-unreachable / reconnect-failure / workflow-log-failure / content-script-unavailable` 这类稳定 bucket 汇总，便于做 transport 值班读数和周级稳定性回归。
`direct-cdp` 当前也已经有本地 launch / wait / smoke 链路，适合验证“接管一个已启用 CDP 的真实 Chromium 浏览器”这条 transport；`cdp:smoke` 现在还支持 `--verify-reconnect` 和 `--verify-workflow-log`，可以把浏览器重启后的 session 恢复和 replay/operator workflow-log 读数一起压过一遍。

模型配置默认会按这个顺序查找：

- `models.local.json`
- `models.json`
- `models.example.json`

当前模型配置同时支持：

- model catalog
- model chain catalog

角色可以通过 `modelRef` 或 `modelChain` 引用模型；`modelChain` 支持 `primary + fallbacks`。

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
- [Browser Relay Bridge v1](./docs/design/browser-relay-bridge-v1.md)
- [Browser Transport v1 Execution Plan](./docs/design/browser-transport-v1-execution-plan.md)
- [Prompt Context Compression Design](./docs/design/prompt-context-compression-design.md)
- [Model Catalog And Chain Config](./docs/design/model-catalog-and-chain-config.md)

## 当前里程碑判断

如果把目标定义为“本地可跑的多角色 runtime 骨架”，当前大致在：

- `95%+`

如果把目标定义为“可日常使用的协作式 agent 桌面工作台”，当前更准确的判断是：

- runtime/workbench backend 接近可用，但仍在验收
- 桌面产品 shell 尚未开始

剩余差距主要集中在：

- browser bridge / relay / direct-cdp 的更长链真实任务 soak / acceptance 覆盖
- runtime/operator 在真实排障过程里的易用性继续打磨
- real-world failure injection 下的长期稳态
- real-world acceptance / evaluation harness 的系统化
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
