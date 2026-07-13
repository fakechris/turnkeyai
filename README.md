# TurnkeyAI

[![npm version](https://img.shields.io/npm/v/@turnkeyai/cli?label=%40turnkeyai%2Fcli)](https://www.npmjs.com/package/@turnkeyai/cli)
[![npm downloads](https://img.shields.io/npm/dm/@turnkeyai/cli)](https://www.npmjs.com/package/@turnkeyai/cli)

**TurnkeyAI 是一个本地优先的 AI 任务工作台。**

你给出一个目标，TurnkeyAI 会把它组织成可执行的 Mission，协调 Agent、浏览器、工具和上下文完成工作。任务过程、证据、审批和结果保留在本地工作台中，方便随时查看、接管和继续。

## 我们想解决什么

复杂任务通常不是“一问一答”：它们需要拆解工作、调用多个工具、等待外部结果、处理失败，并在关键动作前让用户确认。

TurnkeyAI 的目标，是让这类任务可以持续、透明地运行：

- 围绕一个 Mission 组织多个 Agent 和工作项；
- 在需要时使用浏览器、API、本地文件和专业 Worker；
- 对敏感操作发起审批，让用户保留控制权；
- 保存任务上下文、执行证据和产物；
- 任务中断后能够诊断、恢复或继续，而不是从头再来。

## 产品形态

TurnkeyAI 提供桌面应用和 CLI 两种启动方式。它们打开同一个 Control Center，并共享同一套本地 Runtime 和 Mission 数据。

### Desktop App

macOS 桌面应用是日常使用入口，在独立窗口中运行完整的 TurnkeyAI 工作台。

[下载最新 macOS 版本](https://github.com/fakechris/turnkeyai/releases)

当前 DMG 使用 ad-hoc 签名。首次打开时，macOS 可能要求你在“系统设置 → 隐私与安全性”中确认运行。

### CLI

不安装桌面应用也可以通过 CLI 启动浏览器版 Control Center。需要 Node.js 24 或更高版本：

```bash
npx @turnkeyai/cli app
```

命令会启动本地 Runtime，并在浏览器中打开 Control Center。

### Control Center & Local Runtime

Control Center 是 TurnkeyAI 的用户界面。你可以在其中创建和查看 Missions、处理 Approvals、管理 Agents 与 Context，并检查任务运行状态。

Local Runtime 是桌面应用和 CLI 共用的执行层，负责运行任务、保存状态以及连接模型、浏览器和工具。普通使用不需要手动管理 daemon。

详细命令见 [CLI 使用说明](./packages/cli/README.md)。

## 当前方向

TurnkeyAI 仍在持续开发。当前重点是让长任务、多 Agent 协作、浏览器执行、人工审批和失败恢复形成稳定闭环，同时保持本地优先和过程可追溯。

## 文档

- [产品愿景](./docs/VISION.md)
- [产品能力与用户场景](./docs/SPEC.md)
- [CLI 使用说明](./packages/cli/README.md)
- [设计与工程文档](./docs/design/)

## License

Apache-2.0. See [LICENSE](./LICENSE).
