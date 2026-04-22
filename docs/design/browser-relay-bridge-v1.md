# Browser Relay Bridge v1

> 更新日期：2026-04-22
> 目的：定义 `turnkeyai` 的浏览器端 relay bridge 目标形态、分层边界、协议范围和当前落地状态。

## 1. 结论先说

`turnkeyai` 现在已经不再缺 browser runtime 主契约，缺的是第二种正式 transport。

当前已经存在：

- 上层 contract：`BrowserBridge`、`BrowserSession`、`BrowserTarget`、`BrowserTaskRequest`、`BrowserTaskResult`
- 现有本地 transport：`LocalChromeBrowserBridge -> ChromeSessionManager -> playwright-core`
- transport mode 约束：`relay / direct-cdp / local`
- daemon 侧 relay control plane：peer register、heartbeat、target report、action pull/result submit
- browser-side peer 第一版：service worker runtime、peer loop、tab observer、content-script executor
- extension bundling 第一版：可生成 `dist/extension/manifest.json`、`service-worker.js`、`content-script.js`
- relay / direct-cdp smoke、transport soak、reconnect/workflow-log verification 和 validation-ops 汇总

因此，`Browser Relay Bridge v1` 的目标不是重做 browser runtime，而是：

1. 保留现有 `session / target / ownership / replay / recovery` 模型
2. 把 `relay` 作为正式 transport 接进现有 runtime
3. 让 daemon 继续掌握真相，浏览器扩展只负责观察和执行
4. 为真实浏览器接管、登录态延续、手动接力和后续桌面产品留出稳定边界

一句话定义：

> `Browser Relay Bridge v1` 是 `turnkeyai` 自己的浏览器 transport，不是替换现有 local bridge 的重写工程，而是对现有 runtime 的第二条执行通道。

## 2. 产品目标

这条主线只解决 6 个问题：

1. 接管用户已经打开、已经登录的真实 Chrome tab
2. 把浏览器扩展观察到的 tab/frame/action 统一映射回现有 runtime target
3. 把 DOM snapshot、ref、trace、page state 回流到现有 artifact/replay 链
4. 在 relay transport 下保持现有 `ownership / lease / resume / recovery` 语义
5. 在人工介入和自动执行之间建立明确的系统边界
6. 让 `relay` 与 `local` 在同一个 `BrowserBridge` contract 下并存

非目标：

1. v1 不做完整跨浏览器支持，先只收 Chrome/Chromium extension
2. v1 不做完整多 frame orchestration
3. v1 不让浏览器扩展承载 agent/runtime 业务编排
4. v1 不把品牌化浏览器产品直接做成顶层协议类别

## 3. Transport Support Matrix

我们的核心抽象应该是 transport category，而不是产品名目录。

### 3.1 v1 必做的一等 transport

| 类别 | transportMode | 优先级 | 为什么要支持 | 建议实现形态 |
| --- | --- | --- | --- | --- |
| Chrome Relay | `relay` | P0 | 接管真实用户浏览器、真实登录态、手动接力，是 relay bridge 的本体价值 | `relay-adapter` + Chrome extension peer |
| Direct CDP | `direct-cdp` | P0 | 连接本地或远端 Chromium/CDP endpoint，是最通用的自动化后备层 | `direct-cdp-adapter` |
| Local Automation | `local` | P0 | 当前已存在，仍是最稳的回归和本地执行层 | `local-automation-adapter` |

### 3.2 v1.5 可接入，但不是顶层协议类别

| 具体形态 | 应归属到哪一层 | 判断 |
| --- | --- | --- |
| Agent Browser | `direct-cdp` 或 `remote-browser-adapter` | 可以支持，但前提是提供稳定 CDP 或 browser control API |
| Hosted Chromium / Browser-as-a-Service | `direct-cdp` 或 `remote-browser-adapter` | 可以支持，但不应定义核心 bridge contract |
| Chrome relay-like hosted browser | `relay` 或 `remote-browser-adapter` | 可以兼容，但要映射到我们自己的 `session / target / ownership` |

### 3.3 暂不作为 v1 一等目标

| 具体形态 | 原因 | 处理方式 |
| --- | --- | --- |
| Camoufox | 更像浏览器发行版或 anti-detect runtime，不是顶层 relay 协议 | 若兼容 Playwright/CDP，可作为 `local` 或 `direct-cdp` 背后实现 |
| `bbbrowser` 一类品牌化浏览器运行时 | 本质更像 provider，不适合变成核心协议分类 | 若暴露稳定 API/CDP，则适配成 provider-specific adapter |
| 其他品牌浏览器控制产品 | 不应该把 bridge 架构绑在某个产品名上 | 统一走 adapter，不进入 core runtime 抽象 |

设计约束：

1. 顶层 transport enum 只保持 `relay / direct-cdp / local`
2. 任何第三方浏览器能力都只能作为 adapter 背后的实现，不进入主契约
3. 浏览器扩展不是新的 runtime 内核，只是 transport execution plane

## 4. 总体架构

```text
role runtime
  -> worker runtime
    -> browser session runtime
      -> transport adapter
         -> local automation adapter
         -> relay adapter
         -> direct-cdp adapter

relay adapter
  -> local relay gateway (daemon side)
    -> browser relay peer
      -> extension service worker
      -> tab observer
      -> content-script executor
      -> page DOM probe
```

职责切分：

### 4.1 Browser Session Runtime

本地真相层，负责：

1. `BrowserSession` / `BrowserTarget` 生命周期
2. ownership / lease / resume mode
3. dispatch mode：`spawn / send / resume`
4. recovery / replay / history / artifact 回流
5. transport 选择与降级

### 4.2 Relay Adapter

本地 relay transport 适配层，负责：

1. 发现 relay peer
2. 把 browser action 转成 relay protocol message
3. 把浏览器端执行结果转换成 `BrowserTaskResult`
4. 维护 `relayPeer / relayTarget / runtime target` 的映射
5. 把 transport 失败标准化为现有 failure taxonomy

### 4.3 Local Relay Gateway

daemon 子组件，负责：

1. relay peer 注册、鉴权、心跳
2. target report 汇总
3. action request queue / result 回收
4. timeout / stale peer / backpressure

当前 wire transport 是 daemon 内存态 gateway + HTTP control plane：

1. `POST /relay/peers/register`
2. `POST /relay/peers/:peerId/heartbeat`
3. `POST /relay/peers/:peerId/targets/report`
4. `POST /relay/peers/:peerId/pull-actions`
5. `POST /relay/peers/:peerId/action-results`
6. `GET /relay/peers`
7. `GET /relay/targets`

这意味着 browser-side peer 的第一版可以先用 polling/HTTP 接入；以后切到 WebSocket 时，只替换 wire transport，不改上层 runtime contract。

### 4.4 Browser Relay Peer

浏览器端桥，负责：

1. 扩展侧 peer register / heartbeat
2. tab target discovery
3. content script 注入与动作转发
4. page-level snapshot / click / type 执行
5. 向 daemon 回传标准化结果

### 4.5 Content Script / DOM Probe

页面执行层，负责：

1. DOM snapshot
2. ref 抽取
3. element 定位
4. click / type / scroll
5. 局部 console / page-state 采集

不负责：

1. session 真相
2. ownership 判断
3. recovery 策略
4. operator 文案

## 5. 协议范围

### 5.1 核心实体

现有模型继续保留：

- `BrowserSession`
- `BrowserTarget`
- `BrowserProfile`
- `BrowserTaskRequest`
- `BrowserTaskResult`
- `BrowserTransportMode = "relay" | "direct-cdp" | "local"`

relay 侧补充实体：

```ts
type RelayPeerId = string;
type RelayTargetId = string;
type RelayFrameId = string;

interface RelayPeer {
  relayPeerId: RelayPeerId;
  browserName: "chrome";
  extensionVersion: string;
  userAgent?: string;
  connectedAt: string;
  lastHeartbeatAt: string;
}

interface RelayObservedTarget {
  relayPeerId: RelayPeerId;
  relayTargetId: RelayTargetId;
  relayFrameId?: RelayFrameId;
  url: string;
  title?: string;
  attached: boolean;
}
```

### 5.2 v1 动作面

v1 第一版动作面已经不再只停留在最小四个动作。当前主 contract 覆盖：

1. `open`
2. `snapshot`
3. `click`
4. `type`
5. `hover`
6. `key`
7. `select`
8. `drag`
9. `scroll`
10. `console`
11. `probe`
12. `wait`
13. `waitFor`
14. `dialog`
15. `popup`
16. `storage`
17. `cookie`
18. `eval`
19. `network`
20. `download`
21. `upload`
22. `screenshot`
23. `cdp`

设计要求：

1. 所有动作都要回流统一 `trace / page / artifact`
2. local / relay / direct-cdp 都产出同形态 `BrowserTaskResult`
3. 高风险动作必须由 route validation、relay protocol allow-list、smoke/soak marker 同时兜住
4. download/upload 只通过 artifact store 交接，不把本地路径暴露给 relay peer

## 6. 当前代码落地状态

截至 2026-04-04，代码状态是：

### 6.1 已完成

- transport 抽象已存在：
  - [transport-adapter.ts](../../packages/browser-bridge/src/transport/transport-adapter.ts)
  - [local-automation-adapter.ts](../../packages/browser-bridge/src/transport/local-automation-adapter.ts)
- relay transport 入口已存在：
  - [browser-bridge-factory.ts](../../packages/browser-bridge/src/browser-bridge-factory.ts)
  - [relay-adapter.ts](../../packages/browser-bridge/src/transport/relay-adapter.ts)
  - [relay-gateway.ts](../../packages/browser-bridge/src/transport/relay-gateway.ts)
  - [relay-protocol.ts](../../packages/browser-bridge/src/transport/relay-protocol.ts)
- daemon relay routes 已接入：
  - [daemon.ts](../../packages/app-gateway/src/daemon.ts)
- browser-side peer 第一版已存在：
  - [daemon-relay-client.ts](../../packages/browser-relay-peer/src/daemon-relay-client.ts)
  - [peer-runtime.ts](../../packages/browser-relay-peer/src/peer-runtime.ts)
  - [peer-loop.ts](../../packages/browser-relay-peer/src/peer-loop.ts)
  - [chrome-extension-service-worker.ts](../../packages/browser-relay-peer/src/chrome-extension-service-worker.ts)
  - [chrome-tab-observer.ts](../../packages/browser-relay-peer/src/chrome-tab-observer.ts)
  - [chrome-action-executor.ts](../../packages/browser-relay-peer/src/chrome-action-executor.ts)
  - [chrome-content-script.ts](../../packages/browser-relay-peer/src/chrome-content-script.ts)
  - [chrome-content-script-protocol.ts](../../packages/browser-relay-peer/src/chrome-content-script-protocol.ts)
  - [chrome-extension-manifest.ts](../../packages/browser-relay-peer/src/chrome-extension-manifest.ts)
- extension artifact 第一版已存在：
  - [package.json](../../packages/browser-relay-peer/package.json)
  - [tsup.config.ts](../../packages/browser-relay-peer/tsup.config.ts)
  - [write-extension-manifest.ts](../../packages/browser-relay-peer/scripts/write-extension-manifest.ts)

### 6.2 剩余缺口

1. relay / direct-cdp 的真实环境长链样本还要继续扩充
2. scheduled/nightly transport soak 的稳定读数还要持续积累
3. Phase 1 readiness gates 需要在真实 release 环境中跑到稳定 passed
4. 多 frame / 跨浏览器 / provider-specific remote browser 仍不属于 v1 已完成范围

## 7. 路线图

### Phase A: Transport Foundation

目标：

1. 固定 `relay / direct-cdp / local` 三类 transport 边界
2. 保持 local 路径不回归
3. 让 relay transport 以显式配置启用

状态：已完成

### Phase B: Relay Control Plane

目标：

1. daemon side relay gateway
2. peer lifecycle
3. target discovery / attach
4. action queue / result submit

状态：已完成第一版

### Phase C: Browser-Side Peer

目标：

1. service worker runtime
2. tab observer
3. content-script executor
4. 最小动作 `open / snapshot / click / type`

状态：已完成第一版

### Phase D: Installable Extension Artifact

目标：

1. 真正产出可安装的 `dist/extension`
2. service worker / content script bundling
3. 安装说明与本地连通性验证

状态：已完成第一版

### Phase E: Action Parity And Diagnostics

目标：

1. 补齐 high-risk action contract
2. relay-specific failure taxonomy
3. relay continuity 进入 replay / operator / recovery 主线
4. rich action parity、CDP control plane、artifact safety 进入 transport soak

状态：已完成第一版

### Phase F: Direct CDP

目标：

1. 新增 `direct-cdp-adapter`
2. 让 `direct-cdp` 复用既有 session/runtime 契约
3. 与 `relay`、`local` 保持同形态结果

状态：已完成第一版

## 8. 落地原则

后续实现必须遵守：

1. session / target 真相只在 daemon runtime
2. 扩展只负责观察和执行，不负责业务编排
3. relay 失败必须可诊断，不能静默回退成 local
4. 新 transport 不得破坏现有 replay / recovery / operator 语义
5. 先让 transport 跑通，再补动作面和产品 polish

## 9. 下一步执行

当前最短路径已经不是继续补 relay 第一版代码，而是把 Phase 1 exit 跑实：

1. `validation-profile-run phase1-e2e`
2. `transport-soak 3 relay direct-cdp`
3. `release-verify`
4. `soak-series 3 acceptance realworld soak`
5. `validation-ops` 确认 Phase 1 readiness gates 的 passed/failed/missing 状态
