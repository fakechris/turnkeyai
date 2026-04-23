# Phase 1 Readiness And Release Runbook

> 更新日期：2026-04-23

## 目标

把 Phase 1 exit 从“机制已经完成”推进到“可重复验证、可发布、可回滚”的操作闭环。当前北极星指标是 real-world closed-loop rate：真实 runbook 要么 completed，要么失败后进入 actionable gate；`silent_failure` 和 `ambiguous_failure` 不能进入发版。

本 runbook 只覆盖当前公开 CLI/npm 分发链路，不引入新的 runtime 主线。

## 前置条件

1. 本地分支必须基于最新 `main`。
2. `npm run typecheck` 和 `npm run build` 必须通过。
3. 发布环境必须具备 npm publish 权限。
4. CI 或发布环境必须配置 `NPM_TOKEN`。
5. 真实 transport gate 需要本机可启动 Chrome/Chromium，并允许 relay extension 和 direct-cdp smoke 使用临时 profile。

## Phase 1 Exit Gate

推荐先在本地 daemon/TUI 中跑完整 readiness：

```bash
npm run daemon
npm run tui
```

在 TUI 内执行：

```text
phase1-readiness 3 3
validation-ops
```

`phase1-readiness 3 3` 会依次写入四类 `validation-ops` 记录：

1. `validation-profile-run phase1-e2e`
2. `transport-soak 3 relay direct-cdp`
3. `release-verify`
4. `soak-series 3 acceptance:phase1-production-closure realworld:phase1-production-closure-runbook soak:phase1-production-closure-long-chain soak:transport-soak-validation-ops-readiness`

完成标准：

1. `validation-ops` 中 `phase1 readiness=passed`。
2. 四个 gate 都有最新 passing run。
3. `validation-ops` 中 `north-star closedLoop=completed`，或失败时至少是 `actionable` 且明确列出 gate、bucket 和 rerun command。
4. `silent_failure=0` 且 `ambiguous_failure=0`。
5. transport soak artifact 路径可回看。
6. 若任一 gate failed，先按 `validation-ops` 的 `north-star next` 或 `phase1 next` 命令重跑最小失败面，不直接发版。

## Release Verification

发版前单独跑一次 release verification：

```bash
npm run release:verify
```

完成标准：

1. `build-cli` passed。
2. `pack-cli` passed。
3. `package-metadata` passed。
4. `package-files` passed。
5. `bin-help-smoke` passed。
6. `dist-help-smoke` passed。
7. `publish-dry-run` passed。

## Publish Sequence

推荐顺序：

1. 确认 `main` 已包含目标 PR。
2. 确认 package version 未重复发布。
3. 创建 release tag。
4. 跑 GitHub Release workflow。
5. 使用 `NPM_TOKEN` 执行 npm publish。
6. 记录 GitHub Release URL、npm package URL、commit SHA 和 tag。

示例：

```bash
git switch main
git pull --ff-only
npm run release:verify
git tag v0.1.x
git push origin v0.1.x
```

## Post-Publish Smoke

发布后在干净目录验证：

```bash
npx @turnkeyai/cli --help
npx @turnkeyai/cli daemon --help
npx @turnkeyai/cli tui --help
```

如果要验证 daemon 真启动：

```bash
npx @turnkeyai/cli daemon
```

另一个终端：

```bash
TURNKEYAI_DAEMON_URL=http://127.0.0.1:4100 npx @turnkeyai/cli tui
```

完成标准：

1. CLI help 输出包含 `turnkeyai daemon` 和 `turnkeyai tui`。
2. daemon 可以启动并响应 health。
3. TUI 可以连上 daemon。

## Rollback

如果 publish 后发现阻断问题：

1. 先停止继续推广该版本。
2. 在 GitHub Release 标记 known issue。
3. 如果 npm 版本仍处于允许窗口且确认需要撤回，按 npm unpublish 政策处理。
4. 否则发布补丁版本，不复用已发布 version。
5. 在 release notes 里记录失败 gate、修复 PR 和新版本。

## 常见失败归因

| 失败点 | 优先检查 | 推荐动作 |
| --- | --- | --- |
| `phase1-e2e` failed | validation case details | 重跑对应 `validation-run suite:item` |
| `transport-soak` failed | artifact、failure bucket、relay peer/CDP endpoint | 重跑 `transport-soak 1 <target>` |
| `release-verify` failed | package metadata、files、dry-run output | 修 package 配置后重跑 `release-verify` |
| `soak-series` failed | suite aggregate、flaky/known/new regression | 重跑最小 selector，必要时标 known issue |
| npm publish failed | `NPM_TOKEN`、package version、registry 权限 | 修权限或 bump version 后重试 |
