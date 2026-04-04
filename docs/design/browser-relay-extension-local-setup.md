# Browser Relay Extension Local Setup

> 更新日期：2026-04-04  
> 目的：说明如何在本地构建、安装并验证 `turnkeyai` 的 Chrome relay extension 第一版。

## 1. 前提

需要：

1. `Node.js 24+`
2. 本地仓库已执行 `npm install`
3. Chrome 或 Chromium

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

默认 daemon relay control plane 走：

```text
http://127.0.0.1:4100
```

当前扩展默认也会连这个地址。

也可以用仓库脚本直接启动一个带扩展的本地 Chrome：

```bash
npm run relay:launch -- --url https://example.com
```

默认会：

1. 使用 `packages/browser-relay-peer/dist/extension`
2. 创建独立的临时 Chrome profile
3. 启动本地 Chrome 并加载该扩展

随后可以等待扩展真正注册到 daemon：

```bash
npm run relay:wait -- --require-target
```

## 4. 安装到 Chrome

1. 打开 `chrome://extensions`
2. 打开右上角 `Developer mode`
3. 选择 `Load unpacked`
4. 选择目录 `packages/browser-relay-peer/dist/extension`

## 5. 当前预期

当前第一版的目标是：

1. 扩展能被 Chrome 接受并加载
2. service worker 能启动
3. 扩展可以向本地 daemon register peer
4. relay transport 的最小动作面具备 `open / snapshot / click / type`
5. 当前还支持 `scroll / console / screenshot`

## 6. 当前限制

截至当前版本，仍然有这些限制：

1. 还没有 `scroll / console / screenshot`
2. 还没有更完整的 extension 安装 smoke / 连通 smoke 自动化
3. 还没有 `direct-cdp-adapter`
4. relay-specific replay / operator / recovery surface 还没完全接齐

## 7. 参考文档

- [Browser Relay Bridge v1](/Users/chris/workspace/turnkeyai/docs/design/browser-relay-bridge-v1.md)
- [Browser Transport v1 Execution Plan](/Users/chris/workspace/turnkeyai/docs/design/browser-transport-v1-execution-plan.md)
