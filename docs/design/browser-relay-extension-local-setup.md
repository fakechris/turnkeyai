# Browser Relay Extension Local Setup

> 更新日期：2026-04-04  
> 目的：说明如何在本地构建、安装并验证 `turnkeyai` 的 Chrome relay extension 第一版。

## 1. 前提

需要：

1. `Node.js 24+`
2. 本地仓库已执行 `npm install`
3. 支持 unpacked extension flag 的 Chromium 系浏览器
4. macOS 上若正式版 `Google Chrome` 忽略 `--load-extension` / `--disable-extensions-except`，优先用 `Microsoft Edge` 或 `Chromium`

## 2. 构建扩展产物

在仓库根目录执行：

```bash
npm run build:relay-extension
```

构建完成后，未打包扩展目录在：

```text
packages/browser-relay-peer/dist/extension
```

默认会生成：

1. `manifest.json`
2. `service-worker.js`
3. `content-script.js`

也可以单独做产物自检：

```bash
npm run verify:relay-extension
```

## 3. 启动 daemon

relay transport 当前需要显式启用：

```bash
TURNKEYAI_BROWSER_TRANSPORT=relay npm run daemon
```

如果 daemon 开启了分层 token，推荐给 relay peer 单独分配：

```bash
TURNKEYAI_BROWSER_RELAY_TOKEN=relay-peer-secret \
TURNKEYAI_BROWSER_TRANSPORT=relay \
npm run daemon
```

默认 daemon relay control plane 走：

```text
http://127.0.0.1:4100
```

当前扩展默认也会连这个地址。

如果配置了 `TURNKEYAI_BROWSER_RELAY_TOKEN`，需要把同一个值写进扩展本地配置里的 `daemonToken`，这样 browser-side peer 只拿 relay peer 权限，不需要共用 admin token。

也可以用仓库脚本直接启动一个带扩展的本地 Chromium 系浏览器：

```bash
npm run relay:launch -- --url https://example.com
```

默认会：

1. 使用 `packages/browser-relay-peer/dist/extension`
2. 创建独立的临时浏览器 profile
3. 优先选择本地 `Microsoft Edge` / `Chromium` / `Google Chrome`
4. 启动浏览器并加载该扩展

如果要显式指定浏览器二进制：

```bash
npm run relay:launch -- --chrome-path "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" --url https://example.com
```

随后可以等待扩展真正注册到 daemon：

```bash
npm run relay:wait -- --require-target
```

如果要一条命令编排：

1. 构建 extension
2. 启动 relay daemon
3. 启动带扩展的浏览器
4. 等待 peer/target 注册

可以直接执行：

```bash
npm run relay:smoke
npm run relay:smoke -- --url https://example.com
```

如果本机默认选中了不接受 extension flag 的浏览器，请显式传 `--chrome-path`。

## 4. 安装到浏览器

1. 打开对应浏览器的扩展管理页
2. 打开右上角 `Developer mode`
3. 选择 `Load unpacked`
4. 选择目录 `packages/browser-relay-peer/dist/extension`

## 5. 当前预期

当前第一版的目标是：

1. 扩展能被 Chrome 接受并加载
2. service worker 能启动
3. 扩展可以向本地 daemon register peer
4. relay transport 的最小动作面具备 `open / snapshot / click / type`
5. 额外动作面已支持 `scroll / console / screenshot`

## 6. 当前限制

截至当前版本，仍然有这些限制：

1. 当前 smoke 仍依赖本地桌面浏览器，不是纯无头链路
2. 还没有 `direct-cdp-adapter`
3. relay-specific replay / operator / recovery surface 还没完全接齐
4. 更长链的 extension action parity 和恢复语义还要继续补

## 7. 参考文档

- [Browser Relay Bridge v1](/Users/chris/workspace/turnkeyai/docs/design/browser-relay-bridge-v1.md)
- [Browser Transport v1 Execution Plan](/Users/chris/workspace/turnkeyai/docs/design/browser-transport-v1-execution-plan.md)
