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

## 本地构建与签名

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

## GitHub 自动发布

桌面发布以 `packages/desktop/package.json` 的 `version` 为唯一版本源。发布脚本会生成
`desktop-v<version>` annotated tag；tag 推到 GitHub 后，[Publish Desktop](../../.github/workflows/publish-desktop.yml)
pipeline 会自动：

1. 从该 tag 检出代码并安装 Node.js 24 依赖。
2. 校验 tag 与桌面 package version 完全一致。
3. 构建 arm64 与 x64 DMG。
4. 校验两个 App 的 ad-hoc 签名、无 Team ID，并确认实际架构。
5. 生成 `SHA256SUMS.txt`，保存 GitHub Actions artifact。
6. 创建 `TurnkeyAI Desktop v<version>` GitHub Release，并上传两个 DMG 与校验和；重跑时覆盖同名产物。

日常发布流程：

```bash
# 1. 修改 packages/desktop/package.json 的 version，完成代码审查并提交

# 2. 只做 preflight，不创建 tag、不推送
npm run desktop:release

# 3. 推送当前分支，创建 annotated tag，并推送 tag 触发 pipeline
npm run desktop:release -- --push
```

脚本默认要求 clean worktree，避免把未提交修改误认为已进入发布。确实需要从一个已提交的
HEAD 发布、同时保留其他本地工作时，可显式使用 `--allow-dirty`。版本始终从 committed
`HEAD` 读取，这些本地修改不会影响 tag 或进入 GitHub 构建：

```bash
npm run desktop:release -- --push --allow-dirty
```

若 GitHub runner 失败，不要移动已经公开的 tag。修复后发布新 patch version；如果只是
runner 暂时故障，可在 Actions 页面重跑，或对已有 tag 手动触发：

```bash
gh workflow run publish-desktop.yml -f tag=desktop-v0.1.0
```

## 发布后验收

pipeline 成功只证明构建、签名和上传链路正确。发布后还必须：

1. 从另一台 Mac、干净用户或 macOS 虚拟机中通过浏览器重新下载 DMG。
2. 确认下载文件带有 `com.apple.quarantine`，拖入 Applications，并实际走完“隐私与安全性 → 仍要打开”。本地构建目录中的 App 不能代替这项验收。
3. 用 Release 中的 `SHA256SUMS.txt` 复核下载文件。

关闭 Electron 窗口不会停止 daemon，因此之后仍可用 `npm run app` 或
`turnkeyai app` 在浏览器继续访问同一个本地工作台。
