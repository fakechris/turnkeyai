# Browser Relay Bridge v1

> 更新日期：2026-06-04
> 目的：定义 `turnkeyai` 浏览器 relay bridge 的目标形态、当前代码契约、协议边界和仍需持续验证的风险。

## 1. 结论先说

`Browser Relay Bridge v1` 已经不是设计草图。当前代码里，`relay` 已作为正式 browser transport 接入统一 runtime，与 `local` 和 `direct-cdp` 并列。

当前已经存在：

- 上层 contract：`BrowserBridge`、`BrowserSession`、`BrowserTarget`、`BrowserTaskRequest`、`BrowserTaskResult`
- transport mode：`local` / `relay` / `direct-cdp`
- daemon 侧 relay control plane：peer register、heartbeat、target report、action pull/result submit、action inspection
- browser-side peer：Chrome extension service worker、peer runtime、poll loop、tab observer、content-script executor、Chrome debugger/CDP executor
- extension 安装链路：`turnkeyai bridge install-extension`、doctor 检查、relay smoke / install smoke
- relay / direct-cdp smoke、transport soak、reconnect/workflow-log verification 和 validation-ops 汇总

一句话定义：

> `Browser Relay Bridge v1` 是 TurnkeyAI 自己的浏览器 transport。它让 daemon 保持 session/target/ownership/replay/recovery 真相，浏览器扩展只负责观察真实 Chrome tab 并执行已授权动作。

## 2. 产品目标

这条主线解决 6 个问题：

1. 接管用户已经打开、已经登录的真实 Chrome / Chromium tab
2. 把扩展观察到的 tab 映射回 runtime target
3. 把 DOM snapshot、ref、trace、page state、screenshot、download 回流到 artifact/replay 链
4. 在 relay transport 下保持现有 ownership / lease / resume / recovery 语义
5. 在人工介入和自动执行之间建立明确的系统边界
6. 让 `relay`、`local`、`direct-cdp` 在同一个 `BrowserTransportAdapter` contract 下并存

非目标：

1. v1 不做完整跨浏览器支持，先只收 Chrome/Chromium extension
2. v1 不做完整多 frame orchestration
3. v1 不让浏览器扩展承载 agent/runtime 业务编排
4. v1 不把品牌化浏览器产品直接做成顶层协议类别

## 3. Transport Support Matrix

顶层抽象是 transport category，不是产品名目录。

| 类别 | transportMode | 状态 | 当前实现形态 |
| --- | --- | --- | --- |
| Chrome Relay | `relay` | 已完成第一版，继续扩大 soak | `RelayBrowserAdapter` + daemon `RelayGateway` + Chrome extension peer |
| Direct CDP | `direct-cdp` | 已完成第一版，继续扩大 smoke/soak | `DirectCdpBrowserAdapter` |
| Local Automation | `local` | 稳态保持 | `LocalAutomationAdapter` / Playwright-backed local bridge |

设计约束：

1. 顶层 transport enum 只保持 `local / relay / direct-cdp`
2. 第三方浏览器能力只能作为 adapter 背后的 provider，不进入主契约
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
      -> Chrome debugger/CDP executor
```

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
4. 维护 `relayPeer / relayTarget / runtime target` 映射
5. 持久化 snapshot / screenshot / download artifact
6. 把 transport 失败标准化为现有 failure taxonomy

### 4.3 Local Relay Gateway

daemon 子组件，负责：

1. relay peer 注册、鉴权、身份绑定和心跳
2. target report 汇总
3. action request queue / result 回收
4. bounded long polling
5. timeout / stale peer / claim lease / reclaim

当前 wire transport 是 daemon 内存态 gateway + HTTP control plane。浏览器端 peer 第一版用 HTTP long polling 接入；以后切到 WebSocket/SSE 时，应只替换 wire transport，不改上层 runtime contract。

### 4.4 Browser Relay Peer

浏览器端桥，负责：

1. peer register / heartbeat
2. tab target discovery
3. content script 注入与页面动作转发
4. Chrome debugger/CDP 动作执行
5. page-level snapshot / click / type / scroll / screenshot 等动作执行
6. 向 daemon 回传标准化结果

不负责：

1. session 真相
2. ownership 判断
3. recovery 策略
4. operator 文案

## 5. 当前协议快照

### 5.1 HTTP Routes

当前 daemon relay routes：

| Route | 权限 | 用途 |
| --- | --- | --- |
| `POST /relay/peers/register` | `relay-peer` 或 `admin` | 注册 peer，并把 token 与 peerId 绑定 |
| `POST /relay/peers/:peerId/heartbeat` | bound peer | 刷新 peer lastSeen，并续约该 peer 的 inflight claim |
| `POST /relay/peers/:peerId/targets/report` | bound peer | 上报当前可观察 tab targets |
| `POST /relay/peers/:peerId/pull-actions` | bound peer | 拉取下一条可 claim action；支持 `waitMs` long polling |
| `POST /relay/peers/:peerId/action-results` | bound peer | 提交执行结果，必须匹配 active `claimToken` |
| `GET /relay/peers` | read/operator/admin | 查看 peers |
| `GET /relay/targets` | read/operator/admin | 查看 targets，可按 `peerId` 过滤 |
| `GET /relay/actions` | read/operator/admin | 查看 pending/inflight action queue |

认证支持：

1. `Authorization: Bearer <token>`
2. `x-turnkeyai-token: <token>`

分层 token：

1. `TURNKEYAI_DAEMON_READ_TOKEN`
2. `TURNKEYAI_DAEMON_OPERATOR_TOKEN`
3. `TURNKEYAI_BROWSER_RELAY_TOKEN`
4. `TURNKEYAI_DAEMON_ADMIN_TOKEN`
5. legacy `TURNKEYAI_DAEMON_TOKEN`

relay peer 应优先使用 `TURNKEYAI_BROWSER_RELAY_TOKEN`，避免共用 admin/operator token。

### 5.2 实体与状态

当前代码中的 relay 实体以 `packages/browser-bridge/src/transport/relay-protocol.ts` 为准：

```ts
interface RelayPeerRegistration {
  peerId: string;
  label?: string;
  capabilities?: string[];
  transportLabel?: string;
}

interface RelayPeerRecord {
  peerId: string;
  label?: string;
  capabilities: string[];
  transportLabel?: string;
  registeredAt: number;
  lastSeenAt: number;
  status: "online" | "stale";
}

interface RelayTargetReport {
  relayTargetId: string;
  url: string;
  title?: string;
  status?: "open" | "attached" | "detached" | "closed";
}

interface RelayTargetRecord extends RelayTargetReport {
  peerId: string;
  lastSeenAt: number;
}
```

当前 action lifecycle：

1. daemon 创建 pending `RelayActionRequest`
2. peer 通过 `/pull-actions` claim
3. gateway 写入 `claimToken / claimedAt / claimExpiresAt / assignedPeerId`
4. peer 执行动作，并在执行期间定期 heartbeat
5. peer 通过 `/action-results` 提交结果
6. gateway 校验 `peerId + actionRequestId + claimToken`
7. relay adapter 转成 `BrowserTaskResult`，并写 history / artifact

当前默认时间窗：

| 语义 | 默认值 |
| --- | --- |
| peer stale | 90s |
| action timeout | 90s |
| claim lease | 10s |
| peer long poll wait | 25s |
| execution heartbeat | 2s |

### 5.3 动作面

当前 relay action allow-list：

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
12. `permission`
13. `wait`
14. `waitFor`
15. `dialog`
16. `popup`
17. `storage`
18. `cookie`
19. `eval`
20. `network`
21. `download`
22. `upload`
23. `screenshot`
24. `cdp`

设计要求：

1. 所有动作都要回流统一 `trace / page / artifact`
2. local / relay / direct-cdp 都产出同形态 `BrowserTaskResult`
3. 高风险动作必须由 route validation、relay protocol allow-list、smoke/soak marker 同时兜住
4. download/upload 只通过 artifact store 交接，不把任意本地路径暴露给 relay peer

## 6. 当前代码落点

核心文件：

- [transport-adapter.ts](../../packages/browser-bridge/src/transport/transport-adapter.ts)
- [relay-protocol.ts](../../packages/browser-bridge/src/transport/relay-protocol.ts)
- [relay-gateway.ts](../../packages/browser-bridge/src/transport/relay-gateway.ts)
- [relay-adapter.ts](../../packages/browser-bridge/src/transport/relay-adapter.ts)
- [relay-routes.ts](../../packages/app-gateway/src/routes/relay-routes.ts)
- [daemon-auth.ts](../../packages/app-gateway/src/daemon-auth.ts)
- [daemon-relay-client.ts](../../packages/browser-relay-peer/src/daemon-relay-client.ts)
- [peer-runtime.ts](../../packages/browser-relay-peer/src/peer-runtime.ts)
- [peer-loop.ts](../../packages/browser-relay-peer/src/peer-loop.ts)
- [chrome-extension-service-worker.ts](../../packages/browser-relay-peer/src/chrome-extension-service-worker.ts)
- [chrome-tab-observer.ts](../../packages/browser-relay-peer/src/chrome-tab-observer.ts)
- [chrome-action-executor.ts](../../packages/browser-relay-peer/src/chrome-action-executor.ts)
- [chrome-content-script.ts](../../packages/browser-relay-peer/src/chrome-content-script.ts)
- [chrome-extension-manifest.ts](../../packages/browser-relay-peer/src/chrome-extension-manifest.ts)
- [bridge.ts](../../packages/cli/src/bridge.ts)
- [doctor.ts](../../packages/cli/src/doctor.ts)

## 7. 当前完成状态

已完成第一版：

1. `relay / direct-cdp / local` transport 边界
2. daemon relay gateway 和 HTTP routes
3. relay peer identity binding
4. browser-side peer runtime / loop / service worker lifecycle
5. Chrome tab observer 和 content-script executor
6. rich action parity 第一版
7. screenshot / snapshot / download artifact 回流
8. CLI install-extension / doctor 检查
9. relay / direct-cdp smoke、transport soak、validation-ops 接线

仍需持续验证：

1. 更长链真实环境 relay / direct-cdp soak
2. daemon 重启时内存态 gateway 队列与真实浏览器副作用之间的一致性风险
3. 多 peer、多 tab、高并发 claim reclaim 下的目标选择确定性
4. long-running action 的 at-least-once 语义与非幂等动作副作用边界
5. provider-specific remote browser 仍不属于 v1 已完成范围

## 8. 落地原则

后续实现必须遵守：

1. session / target 真相只在 daemon runtime
2. 扩展只负责观察和执行，不负责业务编排
3. relay 失败必须可诊断，不能静默回退成 local
4. 新 transport 不得破坏现有 replay / recovery / operator 语义
5. peer identity、capability、target lock、claim token 必须共同决定 action 是否可执行

## 9. 验证入口

本地安装和连通：

```bash
turnkeyai bridge install-extension
turnkeyai doctor
npm run relay:smoke
npm run relay:install-smoke
```

transport 和 readiness：

```bash
validation-profile-run phase1-e2e
transport-soak 3 relay direct-cdp
phase1-readiness 3 3
validation-ops
```

参考文档：

- [Browser Relay Extension Local Setup](./browser-relay-extension-local-setup.md)
- [Browser Transport v1 Execution Plan](./browser-transport-v1-execution-plan.md)
- [Raw CDP Expert Lane Runbook](./raw-cdp-expert-lane-runbook.md)
