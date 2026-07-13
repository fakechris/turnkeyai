# TurnkeyAI Windows 跨平台能力调研

> 调研日期：2026-07-13
> 文档性质：静态代码审计与迁移方案；不代表已经完成 Windows 实机验证

## 1. 结论摘要

TurnkeyAI 的核心运行时具备较好的 Windows 可移植基础：主体使用 TypeScript、Node.js 24、HTTP 和浏览器技术，Agent、Team、Worker、模型适配器与 Web Control Center 没有明显的 Unix 架构绑定。

当前还不能把项目描述为“Windows 可用”。主要缺口集中在操作系统适配层，而不是核心业务逻辑：

- 主线 CI 只运行 Ubuntu，没有 Windows 回归信号。
- CLI 的停止进程、日志跟随、常驻服务和启动器仍依赖 POSIX/macOS 语义。
- 本地浏览器发现只包含 macOS Chrome 路径，Windows Edge/Chrome 无法自动发现。
- 文件权限、文件名、原子替换和路径长度没有针对 NTFS/Windows 做防护。
- Electron GUI 原型只在 `desktop-v0.1.0` 标签所在分支中提供 macOS 构建和发布配置，尚未进入 `main`，也没有 Windows 安装包、签名与发布链路。

建议把目标拆成三个层级：

1. **Windows 源码可运行**：预计 3–5 个工程日，完成 P0 适配并在 Windows CI/实机验证。
2. **Windows GUI Beta 可安装**：在源码可运行基础上预计再投入 2–3 周，补齐 Electron、NSIS、进程生命周期和安装测试。
3. **Windows GUI 可公开发布**：整体预计 4–6 周，包含 Authenticode 签名、发布流水线、SmartScreen/Defender 验证和稳定性观察。

以上为 1–2 名熟悉代码库的工程师的粗略估算，不包含证书采购或组织审批等待时间。

## 2. 调研基线与范围

本次审计同时检查了两个代码基线：

| 基线 | 版本 | 用途 |
| --- | --- | --- |
| 主线 | `origin/main`，`aea7b9b3` | 判断当前已合入产品的跨平台能力 |
| Desktop 原型 | `desktop-v0.1.0`，`cb1d11d3` | 判断现有 Electron GUI 移植到 Windows 所需的增量 |

Desktop 原型位于 `feat/stage9-engine-default`，并未包含在上述主线提交中。文档中涉及 `packages/desktop` 和 `.github/workflows/publish-desktop.yml` 的结论均来自该标签，不应被理解为 `main` 已具备桌面发行能力。

审计范围包括：

- Node/TypeScript 核心包与 CLI
- daemon 启停、日志和常驻服务
- 本地浏览器、Relay 和 Direct CDP 路径
- Web Control Center 与 Electron Desktop 原型
- 本地数据目录、文件持久化和凭据权限
- CI、安装包、代码签名和发布流程

本次没有在 Windows 10/11 实机运行，因此“可复用”表示未发现静态阻塞，不等于已经通过 Windows 验收。

## 3. 当前跨平台就绪度

| 模块 | 就绪度 | 主要判断 |
| --- | --- | --- |
| Agent / Team / Worker 核心运行时 | 可复用 | 以 TypeScript、Node API 和结构化数据为主，未发现显著 OS 绑定 |
| 模型适配与 HTTP daemon | 基本可复用 | 网络层跨平台；进程生命周期和运行目录需要适配 |
| Web Control Center | 基本可复用 | React/Vite 浏览器 UI 本身跨平台；启动说明仍偏 macOS |
| TUI | 需验证 | 使用 Node 终端能力，理论可运行，但需在 Windows Terminal 验证输入、颜色、resize 和退出行为 |
| CLI | 需改造 | 已有部分 Windows URL 打开逻辑，但启动器、日志、服务和进程停止仍有平台缺口 |
| Local 浏览器模式 | 阻塞 | Chrome 可执行文件发现只覆盖 macOS 固定路径 |
| Relay / Direct CDP | 需验证 | 协议本身跨平台；浏览器启动、扩展安装说明和进程清理仍需 Windows 适配 |
| 文件持久化 | 需加固 | 缺少 Windows 保留名、大小写冲突、路径长度、ACL 和 rename 重试策略 |
| Electron 开发壳 | 需改造 | GUI 壳结构可复用，但当前只定义 macOS 构建目标 |
| Windows 安装与发布 | 缺失 | 没有 NSIS、`.ico`、签名、Windows 构建产物或发布 Job |
| Windows CI | 缺失 | `.github/workflows/ci.yml` 的 typecheck/test/build 均只在 `ubuntu-latest` 运行 |

## 4. 关键问题与证据

### 4.1 缺少 Windows CI，现状无法持续证明

主线 `.github/workflows/ci.yml` 中的 typecheck、test 和 build 都固定为 `ubuntu-latest`。这会让路径分隔符、大小写、shell、进程信号和文件锁问题直到人工测试或发布阶段才暴露。

Windows CI 应当是第一项改造。它既是迁移工作的反馈回路，也是后续每项平台适配的验收门禁。

### 4.2 平台行为散落在 CLI 中

当前已经存在一部分正确的 Windows 分支，例如 `packages/cli/src/app-command.ts` 使用 `cmd /c start` 打开 Control Center URL；但其他入口没有复用同一套行为：

- `packages/cli/src/bridge.ts` 在 Windows 上直接 `spawn("start")`。`start` 是 `cmd.exe` 内建命令，不是普通可执行文件。
- `packages/cli/src/app-command.ts` 生成的安装启动器始终是 POSIX shell 内容，非 macOS 平台也返回 `.sh` 文件。
- `packages/cli/src/doctor.ts` 直接执行 `turnkeyai`；Windows 上全局 npm 命令通常通过 `.cmd` shim 暴露，直接 spawn 的行为需要统一处理和测试。

建议建立单一 `platform-runtime` 模块，集中管理命令执行、URL 打开、应用数据目录、日志跟随、浏览器发现和强制终止。CLI、Desktop 和测试脚本只调用该层，不再各自判断 `process.platform`。

### 4.3 daemon 生命周期依赖 POSIX 信号

`packages/cli/src/daemon-commands.ts` 使用 `SIGTERM` 等待退出，超时后使用 `SIGKILL`。Windows 不提供与 Unix 相同的信号和子进程树语义，不能依靠这条路径实现可控的优雅关闭。

推荐做法：

1. daemon 提供仅绑定 loopback、要求本地 token 的 `POST /admin/shutdown`。
2. CLI/Desktop 先通过 HTTP 请求优雅退出并等待健康检查失效。
3. 超时后再进入平台 fallback：Unix 使用信号；Windows 使用受控的进程树终止。
4. PID 文件中加入进程启动时间或实例 ID，避免 PID 复用后误杀其他进程。

Electron 原型会 detached spawn 内置 daemon，并在非 macOS 平台关闭所有窗口时退出 GUI，但不会同步关闭 daemon。Windows 产品需要明确选择“关闭窗口即停止”“最小化到托盘继续运行”或“daemon 作为独立常驻服务”，并让设置、托盘菜单和卸载行为一致。

### 4.4 日志与常驻服务仅覆盖 Unix/macOS

- `turnkeyai daemon logs` 直接调用 `tail`，标准 Windows 环境没有该命令。
- `turnkeyai daemon service ...` 明确只支持 macOS LaunchAgent，并调用 `launchctl`。
- Control Center 的无 token 页面展示 Finder、`.command` 和 LaunchAgent 指引。

日志跟随应改为 Node 文件读取实现，处理文件增长、截断和轮转。Windows 自启动建议优先采用“当前用户”的 Task Scheduler 任务；不建议直接使用 Windows Service 承载需要访问用户桌面浏览器的进程，因为 Session 0 隔离会带来浏览器和用户配置访问问题。

### 4.5 本地浏览器发现只覆盖 macOS

`packages/browser-bridge/src/chrome-session-manager.ts` 的候选路径只有显式参数、两个环境变量和 macOS 的 Chrome/Chromium 路径。Windows 上即使已经安装 Edge 或 Chrome，本地模式也会报告找不到浏览器。

Windows 建议的查找优先级：

1. 显式 CLI 参数
2. `TURNKEYAI_BROWSER_PATH`
3. Playwright `channel: "msedge"` / `channel: "chrome"` 或其可执行路径解析
4. `%PROGRAMFILES%`、`%PROGRAMFILES(X86)%` 与 `%LOCALAPPDATA%` 下的 Edge/Chrome 标准位置

相同解析器必须同时供 browser bridge、CDP/Relay 启动脚本、doctor 和 smoke test 使用。Edge 可作为 Windows 默认首选，但仍保留 Chrome 和自定义路径。

### 4.6 文件系统语义需要 Windows 加固

`packages/app-gateway/src/daemon-runtime-paths.ts` 默认使用 `~/.turnkeyai`，这在 Node 上可工作，但不是 Windows 原生应用惯例。建议新增平台数据目录策略，同时保留 `TURNKEYAI_HOME` 为最高优先级，并提供旧目录探测或迁移，避免已有数据静默丢失。

更重要的兼容性风险包括：

- `mode: 0o600`/`chmod` 不能等价保证 Windows ACL 下只有当前用户可读。
- 部分 store 将业务 ID 直接或转义后用作文件名，需要防护 `CON`、`PRN`、`AUX`、`NUL`、`COM1` 等保留名。
- NTFS 默认大小写不敏感，需要处理仅大小写不同的 ID 冲突。
- 深层目录和长 ID 可能触发路径长度问题。
- `packages/shared-utils/src/file-store-utils.ts` 的原子写入是临时文件后直接 `rename`，没有针对杀毒软件或索引器短暂占用导致的 `EPERM`/`EBUSY` 重试。

建议统一引入文件名 codec：限制组件长度、规避保留名、对超长或不安全 ID 使用稳定 hash，并把逻辑覆盖到所有 file store。凭据文件应在 Windows 上设置当前用户专属 ACL；不要把 POSIX mode 当作安全边界。

### 4.7 Electron GUI 只有 macOS 发行配置

`desktop-v0.1.0` 的 `packages/desktop/package.json` 只提供 `pack:mac`、`dist:mac`、`verify:mac` 和 `build.mac`/`dmg` 配置，并启用 `forceCodeSigning: true`。`.github/workflows/publish-desktop.yml` 也只有 `macos-latest` 的 DMG 发布任务。

Windows GUI 至少需要：

- `electron-builder` 的 `win` 配置和 NSIS target
- Windows `.ico` 图标、应用元数据和安装/卸载策略
- 优先支持 x64；arm64 可在第二阶段加入
- packaged app 中内置 runtime、Control Center 和 `playwright-core` 的路径验证
- Authenticode 或 Azure Trusted Signing 配置，以及签名后验证
- SHA-256 清单与 Windows 构建产物上传
- 安装路径含空格/中文、非管理员安装、单实例和卸载后的数据保留测试

Beta 可以通过明确的 unsigned/nightly 配置产出内部安装包；公开发布不应关闭签名要求来绕过流水线，应建立正式签名和验证步骤。

## 5. 建议的改造计划

### P0：先达到 Windows 源码可运行

1. **建立 Windows CI**
   - 为 Node 24 typecheck、test、CLI build 增加 `windows-latest`。
   - 对依赖 shell 的测试显式设置 `shell`，消除隐含 bash 依赖。
   - 首轮允许单独 Job，稳定后再决定是否使用 OS matrix。

2. **抽取平台适配层**
   - 提供 `openExternalUrl`、`spawnCommand`、`resolveDataDir`、`followLogFile`、`resolveBrowserExecutable`、`terminateProcessTree`。
   - 禁止业务模块直接拼接 `cmd`、`open`、`tail` 或 `launchctl`。

3. **修复 CLI 的 Windows 行为**
   - `.cmd`/`.bat` 通过 `cmd.exe /d /s /c` 或等价安全封装执行。
   - 安装启动器生成 `.cmd` 或 PowerShell 脚本，不在 Windows 返回 `.sh`。
   - 用 Node 实现日志读取和 `--follow`。
   - 修复 Relay 扩展页打开方式，并补含 `&`、空格和非 ASCII 路径的测试。

4. **重做 daemon 停止协议**
   - 增加带认证的本地 shutdown endpoint。
   - Windows fallback 能终止完整子进程树，并验证 PID 身份。
   - 清理陈旧 PID 文件并保证重复 stop 幂等。

5. **补 Windows 浏览器发现**
   - 支持 Edge、Chrome、环境变量和显式路径。
   - doctor 输出最终命中的浏览器和失败候选。
   - 为路径含空格的 Edge/Chrome 安装补自动化测试。

P0 完成标准：在全新 Windows 11 环境中，能够从源码执行 `doctor`、启动/查看/停止 daemon、打开 Web Control Center，并通过 Local 或 Direct CDP 完成一次浏览器 smoke。

### P1：达到 Windows GUI Beta 可安装

1. 把经过评审的 Electron Desktop 代码合入主线，避免长期从分叉分支发布。
2. 增加 `pack:win`、`dist:win`、NSIS x64 和 Windows 图标。
3. 明确 GUI 与 daemon 的生命周期，并实现托盘/退出/重启交互。
4. 使用 `%LOCALAPPDATA%` 或明确的兼容目录，补 ACL 与数据迁移。
5. 加固文件名、路径长度、大小写冲突和原子 rename 重试。
6. 增加 Windows Desktop CI：构建、安装、启动、health、shutdown、卸载 smoke。
7. 调整 Control Center 首次启动文案，使其按平台展示 `.command`、`.cmd`/PowerShell 或 CLI 指引。

P1 完成标准：普通用户无需管理员权限即可安装、首次启动、执行核心任务、退出并重新打开；路径包含空格和中文时行为正常；卸载策略与数据保留提示一致。

### P2：达到公开发布标准

1. 接入 Authenticode/Azure Trusted Signing，并在 CI 验证签名和时间戳。
2. 将 macOS/Windows 构建拆为平台 Job，汇总到单一发布 Job，避免并发修改同一个 GitHub Release。
3. 验证 Defender、SmartScreen、企业代理、离线启动和升级覆盖安装。
4. 建立 Windows 崩溃日志、诊断包和发布回滚说明。
5. 根据用户需求增加 Windows arm64 和自动更新。

## 6. Windows 验收矩阵

| 场景 | 最低验收 |
| --- | --- |
| OS | Windows 11 最新版；至少抽测一个仍受支持的 Windows 10 版本（若产品承诺支持） |
| 架构 | x64 必测；arm64 在发布该产物时纳入 |
| 安装 | 当前用户、无管理员权限、默认路径与自定义含空格/中文路径 |
| Node 源码模式 | Node 24 + npm clean install、typecheck、test、build |
| daemon | start/status/restart/stop、重复命令、异常退出、陈旧 PID、端口占用 |
| 浏览器 | Edge 稳定版、Chrome 稳定版、自定义可执行路径、未安装时的错误提示 |
| GUI | 首次启动、单实例、窗口关闭/托盘/退出、daemon 恢复、离线错误页 |
| 数据 | 重启后持久化、保留名、大小写冲突、长 ID、并发写入、杀毒软件短暂文件锁 |
| 安全 | token/config ACL、loopback 绑定、shutdown 鉴权、安装包签名和时间戳 |
| 卸载/升级 | 覆盖升级、降级阻止或提示、数据保留/删除选择、进程不残留 |

建议 CI 负责确定性检查，Windows 11 x64 实机或 VM 负责安装、浏览器和安全软件场景。不要只在 Wine 中验收 Electron 或浏览器集成。

## 7. 推荐的实施顺序

迁移工作的关键路径是：

`Windows CI → 平台适配层 → CLI/daemon/browser → 文件系统加固 → Electron NSIS → 签名与发布`

不建议先做安装包再修运行时。那会把进程、路径和浏览器问题包装进 GUI，增加定位成本。先让同一份核心代码在 Windows 源码模式稳定运行，再让 Electron 只承担窗口、安装和生命周期编排。

## 8. 参考资料

仓库内主要证据：

- `.github/workflows/ci.yml`
- `packages/cli/src/app-command.ts`
- `packages/cli/src/bridge.ts`
- `packages/cli/src/daemon-commands.ts`
- `packages/cli/src/doctor.ts`
- `packages/browser-bridge/src/chrome-session-manager.ts`
- `packages/app-gateway/src/daemon-runtime-paths.ts`
- `packages/shared-utils/src/file-store-utils.ts`
- `packages/control-center/src/pages/NoTokenPage.tsx`
- Desktop 标签中的 `packages/desktop/package.json`
- Desktop 标签中的 `packages/desktop/src/main.ts`
- Desktop 标签中的 `.github/workflows/publish-desktop.yml`

官方技术参考：

- [Node.js：在 Windows 上启动 `.bat` 和 `.cmd` 文件](https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows)
- [Node.js：Signal events](https://nodejs.org/api/process.html#signal-events)
- [Playwright：BrowserType 与 channel](https://playwright.dev/docs/api/class-browsertype)
- [electron-builder：命令行与 Windows target](https://www.electron.build/docs/cli/)
- [electron-builder：Windows code signing](https://www.electron.build/docs/features/code-signing/code-signing-win/)
- [electron-builder：GitHub Actions](https://www.electron.build/docs/features/github-actions/)
