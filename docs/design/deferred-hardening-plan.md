# 长程运行时遗留加固计划（2026-07-24）

来源：2026-07-24 对 `feat: add durable long-context runtime`（897f8eb1）与
`fix: harden durable context recovery`（20140bf2）的商用稳定性审查。当轮已修复
22 项缺陷（见 PR "fix: harden long-context runtime for production stability"）；
本文将 5 项因架构级/需独立设计而搁置的问题拆细为可立项的执行计划。

优先级排序（按"用户可感知损失 × 发生概率"）：

| # | 项目 | 优先级 | 预估规模 | 依赖 | 状态 |
|---|------|--------|---------|------|------|
| 1 | 浏览器副作用执行点审批 gate | P0（安全） | L（~1-2 周） | 无 | ⏳ 待专项（架构级，跨包协议） |
| 2 | 记忆生命周期与持久化安全 | P1（数据安全） | M（~3-5 天） | 无 | ✅ 已交付（PR #544；衰减 2.4 见下） |
| 3 | memory writer 增量读取 | P1（性能，随线程长度恶化） | M（~3-5 天） | 无 | ✅ 已交付（PR #544，listAfter） |
| 4a | crash 后工作项 reconcile | P1（稳定性） | M | 无 | ✅ 已交付（PR #545） |
| 4b | run-journal 效应转换 WAL | P2（效率） | M | 无 | ⏳ 待专项（崩溃恢复主干） |
| 5 | prompt registry 治理闭环 | P2（治理/可观测） | S-M（~2-3 天） | 无 | ✅ 已交付（PR #546） |

**交付进度（2026-07-24）**：5 个 well-scoped 项目（2、3、4a、5，及项目 2 的
持久化/生命周期子项）已实现、测试、合并入 main（PR #544/#545/#546，均全量测试
绿 + CI 绿）。剩余两项——项目 1（P0 浏览器执行点 gate，跨 worker-runtime/
browser-bridge 协议，需版本兼容）与项目 4b（run-journal 追加式 WAL，触碰崩溃
恢复主干）——是全 plan 中风险最高、影响面最大的，按决策留作各自专注、可充分
评审的专项。下文各项计划保持不变，供承接时使用。

- 项目 2 的**衰减子项（2.4 时效衰减）**已刻意延后，避免扰动已调优的 recall
  排序；其余持久化/过期/淘汰/近重复合并已交付。
- 各项目相互独立，可并行；剩余两项建议先启动项目 1（P0 安全）。

---

## 项目 1：浏览器副作用执行点审批 gate（P0）

**问题**：当前审批 gate 是对派发指令的自然语言分类
（`tool-use.ts` `classifyBrowserSideEffect`），分类失败即 fail-open——
未被动词表命中的变更类指令会零审批执行。本轮已加固中文/英文动词覆盖，
但分类器本质上不可能穷尽表达方式。成熟实现（Claude Code 权限系统、
codex approval modes）都在**动作执行点**强制审批，而非对任务文本分类。

**目标**：browser worker 内每个 mutating action（点击提交、表单发送、
导航后 POST 等）在执行前必须持有父运行时签发的、范围匹配的审批凭证；
无凭证 → fail-closed 阻断并向父级发起 permission_query。

**分阶段**：

1. **动作清单与风险分级**（1 天）
   - 枚举 browser worker 的动作原语（browser_act 的 click/type/submit/
     navigate/upload/download 等），标注哪些是 mutating、哪些只读。
   - 定义风险分级：`read` / `mutate` / `publish` / `credential` /
     `payment`，与现有 `permission_query` 的 scope 枚举对齐。
   - 产出：`docs/design/browser-action-taxonomy.md` + 类型定义。

2. **审批凭证协议**（2-3 天）
   - 设计 `approvedContext` 凭证：`{ approvalId, actionScope,
     targetOriginPattern, expiresAt, singleUse }`，由父运行时的
     ToolPermissionService 签发（复用现有 request/result/apply 流程）。
   - 凭证随 `sessions_spawn` / `sessions_send` 下发到 worker session，
     持久化在 worker session 记录里（crash 后可恢复、过期即失效）。
   - 防重放：singleUse 凭证核销要走 worker session store 的持久化状态。

3. **执行点强制**（3-4 天）
   - browser worker 的动作分发器中：mutating action 且无匹配凭证 →
     返回结构化 `blocked_before_side_effect` 结果（复用现有协议），
     不执行、不重试。
   - 父运行时收到 blocked 结果后走现有 permission_query →
     permission_result → permission_applied → 重新下发（带凭证）。
   - origin 匹配：凭证限定 origin pattern，跳转到第三方域的 mutating
     action 需要新审批。

4. **NL 分类器降级为提前询问**（1 天）
   - 现有分类器保留，但角色从"唯一 gate"降为"预判提示"：命中时提前
     发起审批（减少一次 worker 往返），未命中时由执行点 gate 兜底。

5. **测试与验收**（2-3 天）
   - 单测：无凭证 mutating action 阻断；过期/跨 origin/已核销凭证阻断；
     只读动作不受影响。
   - e2e：扩展 `natural-approval-dry-run-action` 场景；新增"绕过分类器
     的中英文指令仍被执行点拦截"场景。
   - chaos：审批后 daemon 重启，凭证从 worker session 恢复且不重放。

**验收标准**：关掉 NL 分类器（特性开关）后，所有 mutating 浏览器动作
仍然 100% 需要审批才能执行；现有 natural matrix 场景全绿。

**风险**：worker 协议改动涉及 worker-runtime / browser-bridge 消息格式，
需要版本兼容（老 session 无凭证字段时按 fail-closed 处理）。

---

## 项目 2：记忆生命周期与持久化安全（P1）

**问题**：
a) `DurableMemoryRecord.expiresAt` 已定义但全仓库无读取方——记忆永不过期；
b) workspace 快照无记录数/体积上限，无淘汰策略，长期工作区无界膨胀，
   且每次 commit 全量重写快照文件（O(n) 放大）；
c) `writeJsonFileAtomic`（shared-utils/file-store-utils.ts）rename 前后
   均无 fsync——掉电可能留下空目标文件，`readJsonFile` 把空文件当
   `null` → 整个 workspace 的记忆与游标**静默清零**；
d) 单个损坏（非空但坏 JSON）的快照文件会让 `get()` 对所有 workspace
   抛错（跨 workspace 扫描不隔离故障）。

**分阶段**：

1. **fsync 与损坏隔离**（1-2 天，最高优先）
   - `writeJsonFileAtomic`：写 temp → `fsync(fd)` → rename →
     `fsync(dirfd)`。注意这是 shared util，评估对高频写入方
     （run-journal）的延迟影响；必要时提供 `durability: "strict" |
     "fast"` 选项，memory/checkpoint 类 store 用 strict。
   - `readJsonFile` 解析失败：隔离处理——把坏文件 rename 成
     `<name>.corrupt-<ts>`，记 console.error + 报表 attention 信号，
     返回 null（重新开始），不再向上抛。
   - `FileWorkspaceMemoryStore.get()` 逐文件 try/catch，单文件损坏
     不影响其他 workspace。
   - 测试：注入空文件/截断文件/坏 JSON 三种损坏，验证降级与告警。

2. **过期与容量上限**（1-2 天）
   - `list`/`recall`/`commit` 一律过滤 `expiresAt <= now` 的记录；
     commit 时物理清除过期记录（顺带收缩快照）。
   - 每 workspace 记录上限（建议 500）：超限按
     `confidence 升序 → lastConfirmedAt 升序` 淘汰，authoritative
     记录永不自动淘汰（只可被用户来源 supersede/delete）。
   - 淘汰写入 audit（`evicted` 标记），保持可追溯。

3. **近重复合并**（1 天）
   - commit 时按 normalized content（沿用 resolver 的 normalizeContent）
     检测近重复：同 invalidationKey 且内容归一化相同 → 更新
     `lastConfirmedAt` 而非新增记录（解决 memoryId 含 eventId 导致
     同一事实反复陈述产生 N 条记录的问题）。

4. **排序引入时效衰减**（0.5 天）
   - recall 融合分数里加入 `lastConfirmedAt` 衰减因子（如 30 天半衰），
     让被反复确认的事实自然浮升。

**验收标准**：1k 条记录压测下快照体积与 recall 延迟有界；掉电模拟
（kill -9 于写入中）不丢已 fsync 数据、坏文件被隔离并告警。

---

## 项目 3：memory writer 增量读取（P1）

**问题**：`foundations.ts` 的 `loadEvents` 每次 drain 调用
`teamMessageStore.list(workspaceId)` 全量读线程消息（store 逐文件读取），
读取发生在 `minSourceDelta` 门槛判断**之前**。10k 消息的长线程上每个
turn-interval 触发都要 ~10k 次文件读——"长上下文"特性随上下文变长反而
线性变慢，O(N²) 累积 I/O。

**分阶段**：

1. **store 层追加序号**（2 天）
   - `FileTeamMessageStore.append` 时为每条消息分配持久化的单调
     `appendSeq`（每线程一个计数器文件，或复用消息清单 manifest）。
   - 新增 `listAfter(threadId, afterSeq | afterMessageId, limit)`：
     基于 manifest（`manifest.jsonl`：appendSeq → 文件名 的追加式索引）
     只读增量文件。manifest 损坏/缺失时回退全量扫描并重建。
   - 兼容：老线程无 manifest → 首次访问时懒重建（一次全量扫描）。

2. **writer 接入**（1 天）
   - `loadEvents` 改调 `listAfter`，游标直接使用 store 的 appendSeq
     （替换本轮实现的"排序 + lastEventId 锚定"方案——那是无 store
     支持下的过渡态；appendSeq 是其正解）。
   - `minSourceDelta` 门槛可用 manifest 长度先行判断，0 增量时零文件读。

3. **性能验证**（1 天）
   - 基准：10k 消息线程，drain 冷/热耗时；目标增量 drain < 50ms。
   - 回归：`workspace-memory-writer` 全部现有测试 + 乱序/同毫秒追加。

**注意**：本项落地后，项目 2 的 commit 收缩与本项的 manifest 都触碰
store 层，先合并本项再做项目 2.2 可少一次返工。

---

## 项目 4：crash 后工作项 reconcile + journal I/O（P1/P2）

**4a. 僵尸工作项 reconcile（P1，~2 天）**

**问题**：启动恢复覆盖了 role run / flow / worker session / runtime
chain，但不含 work item。daemon 在工作项 `working` 时崩溃且 flow 不可
恢复 → 该项永远 `working`；报表 attention 只看 `blocked`；
`tasks_create` 的按标题去重还会把僵尸项当活项返回给新 run。

- 扩展启动 reconcile（及每小时 reconciliation pass）：`working` 状态
  且其 mission thread 无活跃 role run/flow 的工作项 → 置 `blocked`，
  挂 synthetic blocker（`runtime_orphaned_after_restart`，含原 flow id）。
- 报表 attention 增加 `orphaned_work_items` 信号。
- `tasks_create` 去重命中 blocked+synthetic-blocker 项时，在返回中标注
  "orphaned, needs re-verification" 而非当作进行中。
- 测试：chaos 脚本（`long-context-runtime-chaos.test.ts`）加"working 中
  kill → 重启 → reconcile 置 blocked"场景。

**4b. run-journal 效应转换 I/O 放大（P2，~2-3 天）**

**问题**：每次 effect admit/start/result 都全量重写 journal 状态
（每个工具调用 ~3 次全量写）。长 run（数百工具调用 × 大 transcript）
下是明显的 I/O 放大与延迟来源。

- 方案：效应转换走**追加式 WAL**（`effects.wal.jsonl` 每转换一行），
  round checkpoint 时做快照合并（全量写一次 + 截断 WAL）。
  恢复 = 最近快照 + 重放 WAL 尾部。
- 保持现有语义：admit 持久化先于 dispatch（WAL append + fsync 即满足）；
  WAL append 失败仍 fail-closed。
- 基准：200 工具调用 run 的 journal 写字节数/次数，目标降一个数量级。
- 注意与项目 2.1 的 fsync 策略联动（WAL 用 strict fsync）。

---

## 项目 5：prompt registry 治理闭环（P2）

**问题**：
a) `tokenPolicy`/`requiredCapability` 只进 receipt/观测，无 runtime 强制；
   实际预算来自 ContextBudgeter 的百分比切分，两者可任意漂移；
b) `auditDefaultPromptRegistry()` 拿常量 `DEFAULT_ACTIVE_PROMPT_ROUTE_IDS`
   对着常量 registry 审计——`prompt_registry_invalid` 在生产**永远不会
   触发**；真实运行时配置（`activeToolPromptSectionIds`）只被并列上报，
   不参与审计；
c) section version 全部硬编码 "1.0.0"，registry 与实际 prompt 内容漂移
   不可检测；`duplicateAuthorityKeys` 恒为空（构造器先抛）——死字段。

**分阶段**：

1. **审计接上真实配置**（1 天）
   - `buildLongContextRuntimeReport` 把 live route ids（来自
     `inspection-deps` 的 activeToolPromptSectionIds + 启用的 lifecycle）
     传入 `DEFAULT_PROMPT_SECTION_REGISTRY.audit(...)`。
   - 测试：构造 permissionsEnabled=false 的组合，断言 audit 标记
     permissions section 不可达；坏配置触发 `prompt_registry_invalid`。
   - 顺带删除恒空的 `duplicateAuthorityKeys` 死字段。

2. **tokenPolicy 违约信号**（1 天）
   - `receipt()` 时 `estimatedTokens > tokenPolicy.maxTokens` → receipt
     标 `overBudget: true` + 报表 attention 信号（先观测不强制，避免
     直接改变 prompt 行为）。
   - 第二步（可选）：assembler 计算分段预算时以 registry 的 maxTokens
     为上限收敛 ContextBudgeter 的百分比切分。

3. **内容寻址版本**（0.5-1 天）
   - section `version` 从其 renderer/template 源内容 hash 派生
     （构建期生成或首次注册时计算），registry-内容漂移即体现为
     version 变化，audit 可对比 journal 里的历史 receipt。

4. **requiredCapability 渲染强制**（0.5 天）
   - assembler 渲染 slot 前检查 capability 开关，关闭则 omit 并记
     `omittedSegments` 原因，而不是"有数据就渲染"。

**验收标准**：人为制造三类漂移（路由不可达 / 超预算 / 内容变更），
报表 attention 均能在一次请求内暴露。

---

## 与已修复项的衔接说明

- 本轮 `foundations.ts` 的"稳定排序 + lastEventId 锚定"是项目 3 落地前
  的正确性过渡方案；项目 3 的 store 级 appendSeq 是终态，落地时替换。
- 本轮 sqlite 索引的"损坏即重建"只覆盖派生数据；项目 2.1 的 fsync/隔离
  覆盖权威数据（JSON 快照），两者互补。
- 本轮浏览器分类器的中文动词加固是项目 1 落地前的风险缓解，项目 1
  完成后分类器降级为提前询问优化。
