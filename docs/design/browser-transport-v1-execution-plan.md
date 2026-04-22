# Browser Transport v1 Execution Plan

> 更新日期：2026-04-22
> 目的：把 `Browser Relay Bridge v1` 从设计文档收成明确可执行的里程碑、交付物和验收标准。

## 1. 背景

当前 `turnkeyai` 的 browser runtime 已经具备：

- `local` transport 主链
- relay control plane、peer identity binding、target/action polling/result submit
- browser-side peer、installable extension artifact 和 extension install smoke
- relay / direct-cdp smoke、reconnect/workflow-log verification 和 transport soak
- browser route / relay route 输入与身份边界 hardening

当前 browser transport 已经从“代码可跑”推进到“可安装、可验证、可诊断、可进入持续 soak”。剩余重点不再是补第一版能力面，而是把 Phase 1 exit validation 和长期稳态读数跑实。

这份执行计划只覆盖 `Browser Transport v1`：

1. `relay`
2. `direct-cdp`
3. `local` 稳态保持

不覆盖：

1. Electron
2. 桌面 GUI
3. 新 browser 产品面
4. 更重的 runtime kernel lift

## 2. 目标状态

完成后应满足：

1. `local` 路径继续稳定且不回归
2. `relay` 可以通过浏览器扩展实际安装和连通
3. `relay` 输出的 action/page/trace 可以进入现有 replay/recovery/operator 主线
4. `direct-cdp` 通过同一 browser runtime contract 进入 smoke / soak / validation-ops

## 3. 里程碑

### M1. Transport Foundation

状态：已完成

交付物：

- `BrowserTransportMode`
- `transport-adapter`
- `local-automation-adapter`
- `relay-adapter`
- browser bridge factory

验收标准：

- local 默认路径不变
- relay transport 可显式配置
- relay 未就绪时明确报错，不静默回退

### M2. Relay Control Plane

状态：已完成第一版

交付物：

- daemon relay gateway
- peer register / heartbeat
- target report
- action pull / result submit

验收标准：

- daemon 可列出 peers/targets
- stale peer / timeout / result mismatch 可明确报错

### M3. Browser-Side Peer

状态：已完成第一版

交付物：

- daemon relay client
- peer runtime / poll loop
- service worker runtime
- tab observer
- content-script executor
- 最小动作 `open / snapshot / click / type`

验收标准：

- browser-side peer 能从 daemon 拉动作并回结果
- relay target 能映射到 runtime target
- 页面快照和动作 trace 可回流

### M4. Installable Extension Artifact

状态：已完成第一版

交付物：

1. `dist/extension/manifest.json`
2. `dist/extension/service-worker.js`
3. `dist/extension/content-script.js`
4. 必要 icons / static assets
5. 安装和本地连通说明

当前已完成：

1. `tsup` bundling 配置
2. manifest 生成脚本
3. `packages/browser-relay-peer/dist/extension/*` 第一版产物
4. `relay:install-smoke` 真机安装和 daemon peer/target 连通验证
5. README 中的本地安装 / smoke 说明

验收标准：

1. Chrome `Load unpacked` 可直接安装
2. 扩展启动后能 register peer
3. daemon `GET /relay/peers` 可看到活跃 peer

### M5. Action Parity

状态：已完成第一版

交付物：

1. `open / snapshot / click / type / hover / key / select / drag / scroll`
2. `console / probe / wait / waitFor / dialog / popup`
3. `storage / cookie / eval / network / cdp`
4. `download / upload / screenshot`
5. relay adapter upload/download artifact safety

验收标准：

- relay 与 local 在关键动作上输出同形态结果
- screenshot / console 不需要另起一套结果模型
- transport soak 强制校验 rich action parity、CDP control plane 和 artifact safety marker

### M6. Relay Diagnostics

状态：已完成第一版

交付物：

1. relay-specific failure bucket
2. continuity / reconnect / stale peer 诊断
3. replay / operator / recovery surface 接线
4. validation-ops 中的 transport target bucket、artifact path 和 Phase 1 readiness gates

验收标准：

- relay 失败能在 triage / replay 中被识别为独立 bucket
- 不必翻源码就能看出是 peer、tab、content script 还是 action 失败

### M7. Direct CDP

状态：已完成第一版

交付物：

1. `direct-cdp-adapter`
2. 连接配置模型
3. 本地 launch / wait / smoke 链路
4. reconnect / workflow-log verification
5. transport soak target

验收标准：

- `direct-cdp` 通过同一个 factory 进入 browser runtime
- 结果形态与 `local / relay` 尽量一致

## 4. 推荐开发顺序

原开发顺序已经完成第一版：

1. M4 Installable Extension Artifact
2. M5 Action Parity
3. M6 Relay Diagnostics
4. M7 Direct CDP

后续顺序改为 Phase 1 exit validation：

1. `validation-profile-run phase1-e2e`
2. `transport-soak 3 relay direct-cdp`
3. `release-verify`
4. `soak-series 3 acceptance realworld soak`
5. `validation-ops` 查看 readiness gates

## 5. 文件级落点

### 已有核心文件

- [browser-bridge-factory.ts](/Users/chris/workspace/turnkeyai/packages/browser-bridge/src/browser-bridge-factory.ts)
- [relay-adapter.ts](/Users/chris/workspace/turnkeyai/packages/browser-bridge/src/transport/relay-adapter.ts)
- [relay-gateway.ts](/Users/chris/workspace/turnkeyai/packages/browser-bridge/src/transport/relay-gateway.ts)
- [daemon.ts](/Users/chris/workspace/turnkeyai/packages/app-gateway/src/daemon.ts)
- [daemon-relay-client.ts](/Users/chris/workspace/turnkeyai/packages/browser-relay-peer/src/daemon-relay-client.ts)
- [peer-runtime.ts](/Users/chris/workspace/turnkeyai/packages/browser-relay-peer/src/peer-runtime.ts)
- [chrome-extension-service-worker.ts](/Users/chris/workspace/turnkeyai/packages/browser-relay-peer/src/chrome-extension-service-worker.ts)
- [chrome-tab-observer.ts](/Users/chris/workspace/turnkeyai/packages/browser-relay-peer/src/chrome-tab-observer.ts)
- [chrome-action-executor.ts](/Users/chris/workspace/turnkeyai/packages/browser-relay-peer/src/chrome-action-executor.ts)
- [chrome-content-script.ts](/Users/chris/workspace/turnkeyai/packages/browser-relay-peer/src/chrome-content-script.ts)
- [chrome-extension-manifest.ts](/Users/chris/workspace/turnkeyai/packages/browser-relay-peer/src/chrome-extension-manifest.ts)

### M4 预计新增或重点修改

1. `packages/browser-relay-peer/package.json`
2. `packages/browser-relay-peer/tsup.config.ts` 或等价 bundling 配置
3. `packages/browser-relay-peer/src/chrome-extension-manifest.ts`
4. `packages/browser-relay-peer/dist/extension/*`
5. 安装说明文档

### M5 预计重点修改

1. `packages/browser-relay-peer/src/chrome-action-executor.ts`
2. `packages/browser-relay-peer/src/chrome-content-script.ts`
3. `packages/browser-bridge/src/transport/relay-protocol.ts`
4. `packages/browser-bridge/src/transport/relay-adapter.ts`

### M6 预计重点修改

1. `packages/qc-runtime/*`
2. `packages/tui/src/tui.ts`
3. `packages/app-gateway/src/daemon.ts`
4. replay / operator / recovery 相关 inspection 文件

## 6. 验收命令

每个里程碑至少应通过：

```bash
npm run typecheck
npm test -- --runInBand
npm run build
```

M4 之后额外要求：

```bash
# 目标形态，不一定是当前已有命令
npm run build:relay-extension
```

M6/M7 之后额外要求：

```bash
npm run transport:soak -- --cycles 3
```

## 7. 退出条件

`Browser Transport v1` 收住的最低标准：

1. relay extension 可安装、可连 daemon、可执行 rich action smoke
2. local 不回归
3. relay failure 可被 operator/replay/validation-ops 理解
4. direct-cdp 可通过同一 smoke/soak 验证
5. Phase 1 readiness gates 能看到 passed/failed/missing

代码侧第一版已经达到这些条件；真正出 Phase 1 还需要把 readiness gates 在真实环境中持续跑到稳定 passed。
