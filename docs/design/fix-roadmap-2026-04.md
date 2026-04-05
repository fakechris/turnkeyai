# Fix Roadmap 2026-04

> 更新日期：2026-04-04  
> 目的：基于 `docs/review/REVIEW_ITEM_TRIAGE_2026-04-04.md` 中确认的问题，制定一份**不打断现有功能**的修复路线图。  
> 原则：先修执行可靠性和结构性债，再谈更大抽象；所有改造都以“主干功能不回退、CLI/daemon/TUI/validation 保持可用”为约束。

## 1. 这份路线图解决什么问题

当前仓库的核心问题已经不是“功能有没有”，而是：

1. 关键执行面和查询面过度集中，单文件/单类已经接近维护上限
2. worker runtime 仍然只有 resumability，没有 durability
3. 多 store 写入之间缺少原子性、版本控制和启动时 reconcile
4. 一些关键数据结构仍处于过渡态，后续改动很容易继续累积 schema 债
5. API / operator / replay / recovery 虽然已经很强，但真相一致性和权限边界还不够硬

本路线图不是新的愿景文档，而是一个**修复顺序文档**：

- 先做什么
- 为什么现在做
- 每一步如何避免 breaking change
- 做到什么算过关

## 2. 非破坏式推进原则

后续所有修复必须同时满足下面几条：

1. **不破坏现有入口**
   - `npm run daemon`
   - `npm run tui`
   - `npm run build`
   - `npm test -- --runInBand`
   - `validation-profile-run smoke`
   - `relay:smoke`
   - `cdp:smoke`

2. **先做兼容层，再切默认路径**
   - schema 重构先保留读兼容
   - store 重构先做双写或投影同步
   - route 重构先保留旧 endpoint

3. **每个阶段都必须可独立合并**
   - 不搞“一把梭”大迁移
   - 每阶段必须有单独的回归面和验收标准

4. **先加验证，再改关键路径**
   - 对 crash/restart、cross-store consistency、HTTP contract、worker resume 这些薄弱环节，先补测试或 smoke 再动大结构

5. **不在本轮同时开启新内核**
   - 不做 remote worker
   - 不做 multi-process execution
   - 不做 Electron GUI
   - 不做 durable execution kernel v2

## 3. Canonical Workstreams

本轮 fix roadmap 只围绕下面 10 条主线：

### W1. Daemon / Query / Recovery Decomposition

对应问题：

- `I01`

目标：

- 把 [daemon.ts](../../packages/app-gateway/src/daemon.ts) 的组合、路由、query、recovery action 编排拆开
- 让新功能不再必须理解 3000+ 行单文件

阶段成果：

1. 提取 `composition-root`
2. 提取 `routes/` 分域模块
3. 提取 `runtime-query-service`
4. 提取 `recovery-action-service`

非破坏要求：

- 旧 HTTP 路由路径不变
- daemon 入口命令不变
- 行为不做语义升级，只做结构拆分

### W2. Worker Session Durability

对应问题：

- `I02`
- `I07`

目标：

- 让 worker session 不再只存在于内存
- 明确“可恢复”和“不可恢复”的边界，不再让 recovery 假装 durable

阶段成果：

1. `WorkerSessionStore` 接口
2. file-backed session store
3. `InMemoryWorkerRuntime` 变 write-through cache
4. 启动时 session 恢复与 stale cleanup
5. recovery / operator 对“cold-recreated vs resumed”显式可见

非破坏要求：

- 当前 worker handler 接口先不改
- `spawn / send / resume / interrupt / cancel` API 形状先不改
- 先保证现有 handler 和 tests 不需要一次性重写

### W3. Cross-Store Safety And Reconciliation

对应问题：

- `I03`
- `I10`

目标：

- 降低 message/flow/chain/recovery 之间的孤儿状态和脑裂概率
- 增加系统启动后的事实校对能力

阶段成果：

1. startup orphan detection
2. runtime chain / flow / replay / recovery reconciliation pass
3. optimistic concurrency or version field on mutable projections
4. WAL/outbox 方案设计与第一版落地

非破坏要求：

- 先加 reconciliation，不先强推底层存储迁移
- 保留现有 file-backed projection 作为主读取面
- 新 journal/WAL 先作为补偿层，不立即替代全部 store

### W4. Storage Shape Upgrades

对应问题：

- `I04`

目标：

- 把最明显不适合增长的数据结构改成更自然的日志/分段形态

优先目标：

1. `TeamMessage` append-only 化
2. `RecoveryRun.attempts` 外置
3. `ThreadJournal` 结构评估

非破坏要求：

- 保留旧数据读取兼容
- 新写入可双写到新旧格式一个阶段
- 对上层 API 保持返回结构稳定

### W5. Core Type Boundary Cleanup

对应问题：

- `I05`
- 部分 `I14`

目标：

- 把 `core-types` 收回到“领域类型和少量纯 helper”
- 降低 `team.ts` 作为全仓库单一瓶颈的压力

阶段成果：

1. `team.ts` 按 domain 拆分
2. `file-store-utils` 移出 `core-types`
3. `async-mutex` 移出 `core-types`
4. `RuntimeProgressEvent` 等大 union 增加更清楚的 discriminant / schema discipline

非破坏要求：

- 所有旧 import 先通过 `index.ts` re-export 保持可用
- 先做机械拆分，不顺手做概念改写

### W6. Schema Debt Cleanup

对应问题：

- `I06`

目标：

- 收掉 `RelayPayload` / `ScheduledTaskRecord` 的双路径过渡态

阶段成果：

1. 标记 legacy 字段 deprecated
2. 迁移所有读取方到结构化路径
3. 停止双写
4. 删除 fallback helper

非破坏要求：

- 至少一个阶段保留 legacy 读兼容
- 先迁消费者，再删字段

### W7. API Hardening

对应问题：

- `I08`

目标：

- 让 daemon API 更可控、更一致、更适合 operator 使用

阶段成果：

1. route table 化
2. 统一参数校验
3. `/messages` 等核心入口补空白/大小限制校验
4. auth 分层：read / operator / admin
5. validation / relay / recovery 等敏感端点重新分权
6. idempotency 策略设计

非破坏要求：

- 当前 token 模式继续支持
- 先新增能力，不立即删旧 auth 行为
- 旧 endpoint 路径暂不强制升级到 `/v1`

### W8. Browser Transport Contract Sealing

对应问题：

- `I09`

目标：

- 把 `local / relay / direct-cdp` transport 的 authority、ownership、reconnect 语义封到正式 contract 内

阶段成果：

1. relay gateway 不再靠 daemon downcast 获取
2. browser continuation hint 加强校验
3. owner lifecycle / session revoke 语义补齐
4. relay peer registration authority 收紧
5. reconnect/recover diagnostics 更统一

非破坏要求：

- 不重写 transport adapter 总体边界
- 不推翻现有 relay/direct-cdp smoke 工具链

### W9. Truth Alignment For Replay / Recovery / Operator

对应问题：

- `I10`

目标：

- 降低 operator 看见的状态和真实运行状态之间的漂移

阶段成果：

1. reconciliation job 把 stale projection 拉回真实状态
2. replay / recovery 的推断路径增加因果标记
3. stale detection 从“仅查询时判断”升级为“定期更新”
4. 明确“inferred / confirmed / stale”之类的 operator 语义

非破坏要求：

- 先加状态来源标记，再改判定逻辑
- 不直接推翻现有 replay/recovery 数据模型

### W10. Governance / Prompt Admission / Reliability Tests

对应问题：

- `I11`
- `I12`

目标：

- 强化浏览器和外部结果进入 prompt 前的边界
- 补齐当前最缺的可靠性测试层

阶段成果：

1. browser/page excerpt sanitization
2. browser-originated prompt injection defense
3. daemon HTTP contract tests
4. crash/restart tests
5. file-store concurrency tests
6. recovery action E2E tests

非破坏要求：

- 先以 conservative mode 加防御，不先改全套 evidence pipeline
- 测试先覆盖高风险路径，不追求一次全量

## 4. Execution Order

建议严格按下面顺序推进：

### Phase A. Structural Pressure Relief

1. `W1` Daemon / Query / Recovery Decomposition
2. `W6` Schema Debt Cleanup
3. `W5` Core Type Boundary Cleanup

原因：

- 先把最容易阻塞后续工作的结构瓶颈拆开
- 如果不先拆，后面的 worker durability、API hardening、truth alignment 都会继续往 god file 和 giant schema 里堆

### Phase B. Execution Reliability

4. `W2` Worker Session Durability
5. `W3` Cross-Store Safety And Reconciliation
6. `W4` Storage Shape Upgrades

原因：

- 这三条是“系统到底能不能长期运行”的根
- 顺序上先让 worker truth 落盘，再做 cross-store safety，最后改最容易放大 I/O 的 store 形态

### Phase C. External Surface Hardening

7. `W7` API Hardening
8. `W8` Browser Transport Contract Sealing
9. `W9` Truth Alignment For Replay / Recovery / Operator

原因：

- 这几条决定 operator 和 transport 面是不是可信
- 也决定 GUI / remote worker / 更强 operator 面以后能不能安全长出来

### Phase D. Safety Net Expansion

10. `W10` Governance / Prompt Admission / Reliability Tests

原因：

- 一部分测试应该前置穿插补，但完整收口应放在主要结构拆分之后
- 否则很容易给旧架构的坏边界补测试，而不是给更稳的边界补测试

## 5. Stage Plan

### Stage 0. Baseline Guardrails

目标：

- 在动结构前固定保护线，确保后续 refactor 不把现有功能打断

任务：

1. 固定一组必跑验证：
   - `npm run typecheck`
   - `npm test -- --runInBand`
   - `npm run build`
   - `npm run relay:smoke -- --timeout-ms 35000 --peer-count 2 --verify-reconnect --verify-workflow-log`
   - `npm run cdp:smoke -- --timeout-ms 45000 --verify-reconnect --verify-workflow-log`
2. 固定一组最低 operator/read-model checks
3. 文档化“当前哪些语义不是 durable”

完成标准：

- 后续每阶段都能复用同一条 baseline

### Stage 1. Non-Behavioral Structural Split

覆盖：

- `W1`
- `W5` 的机械部分

任务：

1. `daemon.ts` 按 domain 提取 route modules
2. 提取 runtime query service
3. 提取 recovery action service
4. `team.ts` 先机械拆 domain files + re-export
5. 搬出 `file-store-utils` / `async-mutex`

完成标准：

- 对外 API 不变
- smoke / build / tests 全绿
- 新文件职责边界清楚

### Stage 2. Schema Convergence

覆盖：

- `W6`

任务：

1. 标记 legacy dispatch fields deprecated
2. 全量迁移读路径
3. 移除双写
4. 删除 fallback helper

完成标准：

- `RelayPayload` 只剩结构化路径
- `ScheduledTaskRecord` 只剩 `dispatch`
- 相关 helper 大幅减少

### Stage 3. Worker Truth And Restart Recovery

覆盖：

- `W2`
- `W7` 的 restart-related 部分

任务：

1. 引入 `WorkerSessionStore`
2. `InMemoryWorkerRuntime` 变 write-through
3. 启动时恢复 worker sessions
4. 角色 loop / queued run restart sweep
5. operator 显式标记 `resumed` vs `cold-recreated`

完成标准：

- 进程重启后 worker truth 不会全部消失
- recovery 不再无声地把 “resume” 退化成 “fresh”

### Stage 4. Cross-Store Safety

覆盖：

- `W3`
- `W4` 的 message/recovery 优先部分

任务：

1. orphan detection at startup
2. projection reconcile job
3. `TeamMessage` append-only 落地
4. `RecoveryRunAttempt` 外置
5. version field / optimistic concurrency first pass

完成标准：

- message/flow/chain/recovery 的孤儿状态可检测可修复
- 最容易增长的 store 不再靠 read-all/write-all

### Stage 5. API / Transport / Truth Hardening

覆盖：

- `W7`
- `W8`
- `W9`

任务：

1. route table 化和统一 input validation
2. auth 分层
3. relay peer authority 收紧
4. transport contract 收口
5. replay / recovery / operator 的 truth-source 标记
6. stale detection 与 periodic alignment

完成标准：

- operator 面更少靠推断、多一点来源标记
- transport 不再通过 downcast 暴露内部能力
- debug/validation endpoint 权限和生产操作分层

### Stage 6. Safety Nets

覆盖：

- `W10`

任务：

1. browser excerpt sanitization
2. malicious page / prompt injection tests
3. daemon HTTP contract tests
4. crash/restart tests
5. file-store concurrency tests
6. recovery action E2E tests

完成标准：

- “测试全绿”开始更接近“系统稳”

## 6. What Not To Do During This Roadmap

在这份 roadmap 完成前，不建议启动：

1. remote worker / multi-process execution
2. 通用 subagent runtime v2
3. Electron GUI
4. durable execution kernel 重写
5. SQLite 全面替换所有 file-backed store

原因：

- 这些工作会放大当前的结构性债
- 它们依赖的前置是：
  - daemon/query/recovery 拆分
  - worker state durability
  - cross-store safety
  - transport contract sealing
  - truth alignment

## 7. Acceptance Criteria

只有同时满足下面条件，这轮 fix roadmap 才算完成：

1. `daemon.ts` 不再承担完整系统逻辑，剩余职责主要是 composition root + server bootstrap
2. worker session 在进程重启后可恢复，或者被明确标记为 cold recreation
3. startup reconcile 能发现并修复主要 orphan/drift 场景
4. message / recovery attempt 的数据形态不再是明显的 growth trap
5. `RelayPayload` / `ScheduledTaskRecord` 过渡态结束
6. daemon API 有统一验证和权限分层
7. replay / recovery / operator 至少能区分 `confirmed / inferred / stale`
8. browser-originated evidence 有基础 sanitization
9. daemon HTTP / crash-restart / concurrency 测试不再是空白

## 8. Immediate Backlog

如果按最短路径开始，建议先开下面 5 个大批次，而不是碎修：

1. `Batch 1` — `daemon.ts` 路由/query/recovery service 拆分
2. `Batch 2` — `team.ts` 机械拆分 + `core-types` 清理
3. `Batch 3` — `RelayPayload` / `ScheduledTaskRecord` 结构收口
4. `Batch 4` — `WorkerSessionStore` + startup recovery
5. `Batch 5` — `TeamMessage` append-only + orphan/reconcile

## 9. Handoff

可直接交给后续 agent 的 handoff：

```text
当前主仓库是 /Users/chris/workspace/turnkeyai。

当前目标不是加新功能，而是执行 docs/design/fix-roadmap-2026-04.md 里的非破坏式修复路线。

最高优先级：
1. 拆 daemon/query/recovery
2. worker session durability
3. cross-store safety + startup reconcile
4. schema debt cleanup
5. API/operator/transport hardening

推进原则：
- 不打断现有 CLI/daemon/TUI/validation/relay/direct-cdp 功能
- 每阶段独立可合并
- 先兼容，再切默认
- 先补验证，再动关键路径

优先参考：
- docs/review/REVIEW_ITEM_TRIAGE_2026-04-04.md
- docs/design/fix-roadmap-2026-04.md
```
