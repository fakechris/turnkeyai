# TurnkeyAI Desktop

Electron 只负责桌面窗口和本地 daemon 的启动/复用；页面仍由同一个
TurnkeyAI daemon 在 `/app` 提供。这样浏览器调试与桌面 App 不会分叉成两套前端。

## 开发入口

浏览器/Web Server 调试保持不变：

```bash
npm run app
```

启动 Electron 壳：

```bash
npm run desktop:dev
```

如果 daemon 由你单独管理，可让桌面壳只连接现有服务：

```bash
TURNKEYAI_DAEMON_URL=http://127.0.0.1:4100 npm run desktop:dev
```

桌面壳只接受 daemon 实际绑定的 `127.0.0.1` Web Server，避免双栈 loopback 地址歧义，
也避免把本地 daemon token 暴露给远程页面。远程访问仍应使用原有浏览器入口并单独配置网络安全边界。

## macOS 构建与签名

当前固定配置：

- Product Name：`TurnkeyAI`
- Bundle Identifier：`com.turnkeyai.desktop`
- Minimum macOS：`12.0`
- 签名：ad-hoc（electron-builder 的 `mac.identity: "-"`）
- 发布载体：DMG
- 公证：无

构建当前 Apple Silicon 机器使用的 DMG：

```bash
npm run desktop:dist:mac:arm64
npm run desktop:verify:mac
```

同时构建 Apple Silicon 与 Intel DMG：

```bash
npm run desktop:dist:mac
npm run desktop:verify:mac:release
```

产物位于 `packages/desktop/dist/release/`，同时生成 `SHA256SUMS.txt`。
签名验证要求看到 `Signature=adhoc` 与 `TeamIdentifier=not set`。`spctl`
拒绝未公证的 ad-hoc 构建属于预期行为，首次启动需要用户在“系统设置 → 隐私与安全性”
中选择“仍要打开”。

发布前还必须：

1. 将本包 `package.json` 的 `version` 更新到准备发布的版本，GitHub Release tag 必须严格为 `desktop-v<version>`；CI 会忽略其他产品的 Release，并拒绝版本不一致的桌面 tag。
2. 上传 Release 后，从另一台 Mac、干净用户或 macOS 虚拟机中通过浏览器重新下载 DMG。
3. 确认下载文件带有 `com.apple.quarantine`，拖入 Applications，并实际走完“隐私与安全性 → 仍要打开”。本地构建目录中的 App 不能代替这项验收。
4. 用 Release 中的 `SHA256SUMS.txt` 复核下载文件。

关闭 Electron 窗口不会停止 daemon，因此之后仍可用 `npm run app` 或
`turnkeyai app` 在浏览器继续访问同一个本地工作台。
