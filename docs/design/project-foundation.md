# 项目总设计

> 更新日期：2026-03-29
> 目标：在正式写 runtime 骨架前，先把产品形态、技术边界、开发阶段和长期愿景定下来

---

## 1. 项目目标

这个项目的目标不是只复刻某个 relay 协议，也不是只做一个能调用 browser 的 agent demo，而是做一套本地优先、可扩展、可审计的协作式 agent 桌面工作台。

短期目标：

1. 本地运行多角色协作。
2. 支持角色之间 `@mention` 接力。
3. 角色内部可继续派生 browser / coder / finance 等 worker。
4. 在真实日常任务里，把续跑、回放、审计、批准这些关键环节做稳。

中期目标：

1. 让 team / role / worker / browser bridge 共用同一套稳定 runtime。
2. 把当前偏产品护栏的能力，进一步抽象成 durable execution / context / memory / tool kernel。
3. 形成可测试、可压测、可比较模型质量的 Harness 基础设施。

长期愿景：

1. 把它做成一个本地 agent operating system。
2. 既能承载日常运营、开发、研究、财务协作，也能承载长期自动化 worker。
3. 既能做桌面交互，也能做 daemon 化持续执行。

---

## 2. 产品形态判断

### 2.1 最终产品形态

最终形态建议明确为：

- 一个带 GUI 的桌面端应用
- 首选 Electron

原因：

1. 你后面一定会需要会话视图、team 面板、worker trace、browser 截图、权限提示、回放面板。
2. 这些都是典型桌面 GUI 交互，不是 TUI 的强项。
3. Electron 更容易承载本地 gateway、browser bridge、文件持久化和多窗口工具界面。

### 2.2 开发期形态

前期不建议直接先做 GUI，建议分两层推进：

- `daemon` 先落 runtime、store、gateway、worker orchestration
- `TUI` 作为最薄的人机调试面

也就是说，短期方案不是 “TUI 或 Electron 二选一”，而是：

- 目标产品：Electron GUI
- 第一阶段交付：Daemon + TUI

这样做的原因：

1. 先把 runtime 核心做稳，不让 UI 绑架架构。
2. TUI 足够支撑早期验证 team handoff、worker delegation、failure recovery。
3. 后续 GUI 只需要接 gateway 和 event bus，不必重写核心执行逻辑。

---

## 3. 核心能力边界

这几个能力必须从一开始就写进架构，而不是后补。

### 3.1 Team coordination

- 创建 team
- 固定角色槽位
- `@mention` 驱动 handoff
- lead role 收敛

### 3.2 Role runtime

- 角色 prompt 组装
- 模型选择
- 工具裁剪
- 子 worker 委派

### 3.3 Worker runtime

- browser
- coder
- finance
- explore
- harness
- controlled parallel fan-out / fan-in
- merge-synthesis and coverage checks

### 3.4 Browser bridge

- relay / cdp / playwright action 层
- snapshot / screenshot / act / console
- target / session / ref restore

### 3.5 Persistence / replay

- team thread
- flow ledger
- member run
- message timeline
- execution replay

### 3.6 QC / recovery

- handoff anti-loop
- retry / fallback / skip / abort
- lead role fallback
- worker failure recovery

---

## 4. 顶层架构

建议按下面 7 层看整个项目：

1. Shell Layer
   - 早期是 TUI
   - 后期是 Electron GUI
2. Gateway Layer
   - websocket / REST / event bus
3. Coordination Layer
   - team runtime / handoff planner / recovery director
4. Role Layer
   - role runtime / policy / prompt assembly
5. Worker Layer
   - browser / coder / finance / harness
6. Bridge Layer
   - browser bridge / relay / CDP
7. Storage Layer
   - thread / flow / run / message / audit log

关键原则：

- shell 只是壳，不能拥有业务核心。
- runtime 必须先于 GUI 定义完成。
- gateway 是唯一面向 UI 的稳定接口。

---

## 5. 研发阶段计划

### Phase 0: Runtime foundation

交付：

- daemon
- 本地 store
- team runtime skeleton
- TUI 调试入口

目标：

- 跑通 `user -> lead -> member -> lead`

### Phase 1: Worker integration

交付：

- worker runtime
- browser bridge
- 角色内 worker delegation

目标：

- 跑通 `lead -> operator(browser) -> lead`

### Phase 2: Runtime hardening

交付：

- production hardening 第一批
- prompt / memory / compaction 稳定化
- sub-session / browser resume / continue 稳定化
- 并行 sub-agent orchestration 与 merge-synthesis 稳定化
- tool registry / permission / audit / browser fallback 护栏
- replay / failure analysis 第一版产品化

目标：

- 把 runtime 从“能跑”升级成“能稳定完成 bounded 的真实任务”

### Phase 3: Runtime kernel lift

交付：

- durable execution 基础
- context compiler / memory hierarchy / cache taxonomy
- tool policy kernel
- typed delegation / work package

目标：

- 把第一阶段已经跑稳的能力系统化，升级成更强的 runtime 内核

### Phase 4: Quality and harness

交付：

- replay
- evaluation harness
- failure analysis
- model / prompt / policy A/B 能力

目标：

- 从“稳定可用”升级为“能优化、能审计、能规模化”

### Phase 5: Product-grade desktop

交付：

- Electron shell
- team/chat GUI
- trace timeline
- screenshot / browser step viewer
- permission / approval surface

目标：

- 把已经稳定的 daemon + gateway 能力接成可用桌面产品

---

## 6. 技术决策

### 6.1 桌面壳

- 长期：Electron
- 早期：TUI + daemon

### 6.2 执行内核

- TypeScript
- 本地进程优先
- 明确的 flow / run / thread 三层持久化

### 6.3 存储

- 初期用文件存储就够
- schema 要稳定
- 后面可替换成 SQLite，但接口不要绑死

### 6.4 Browser 执行

- browser bridge 独立成单独 package
- 上层只依赖 worker contract，不直接依赖 CDP 细节

---

## 7. 非目标

当前阶段不要做这些事：

1. 不先做复杂 GUI 动效。
2. 不先做远端多租户服务。
3. 不先做全量插件系统。
4. 不先做无限角色类型。

先把本地单用户桌面工作台做稳。

---

## 8. 这份设计对代码骨架的约束

所以在真正起代码前，先定下面几个判断：

1. 仓库从第一天就按 package 分层。
2. skeleton 先服务于 daemon/runtime，不服务于 GUI。
3. GUI 接口以后走 gateway，不允许 UI 直接读写 runtime 内部状态。
4. team / role / worker / browser bridge 的边界在 package 层就要切开。

---

## 9. 一句话结论

当前最合理的路线不是“先做 Electron 或先做 TUI”，而是：

- 产品目标明确为 Electron 桌面端
- 第一阶段实现采用 Daemon + TUI
- 核心工作先放在 runtime / store / worker / bridge

在这个前提下，再起 `packages/*` 的 skeleton 才不会返工。
