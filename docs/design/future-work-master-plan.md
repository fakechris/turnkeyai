# Future Work Master Plan

> 更新日期：2026-04-04  
> 目的：把当前项目从“Phase 1 核心机制已完成”推进到“发布闭环、长期验证、operator 值班、Phase 2 准备”四条主线上的统一执行计划。

## 1. 当前判断

当前仓库已经完成：

- runtime / browser / recovery / context / observability 主机制
- bounded regression / failure injection / acceptance / soak / real-world validation 基础框架
- model catalog + chain catalog 第一版
- operator triage / replay / recovery / prompt console 第一版
- CI、build、release readiness、soak workflow 第一版

当前项目已经不再缺少核心 kernel。剩余工作主要分成四类：

1. Phase 1 的真实任务验收与长期稳态验证
2. 发布与公开分发闭环
3. operator-facing 诊断与 failure taxonomy 的最后收口
4. 为 Phase 2 做边界清晰的准备，而不是提前开大规模新内核

## 2. 工作原则

后续推进只遵守下面几条：

1. 不再为了“看起来更完整”而扩新主线。
2. 优先做能提高真实任务成功率、可诊断性、发布可信度的工作。
3. 把高成本验证放到 nightly / scheduled soak，不把所有重活塞进 PR required checks。
4. 新增工作优先落到已有 validation catalog，而不是再造一套新测试入口。
5. GUI、Electron、重型 kernel lift 都要等 Phase 1 真正收住后再做。

## 3. 主线总览

### A. Public Release And Distribution

目标：

- 真正跑通 GitHub Release -> artifact -> npm publish 的公开分发闭环
- 把“能 dry-run”推进到“真实可发布、可安装、可回滚”

剩余工作：

1. 配置 `NPM_TOKEN`
2. 跑第一次真实 public release
3. 验证 `npx @turnkeyai/cli daemon` / `tui` 在干净环境中可用
4. 固化 release versioning、tagging、rollback 约定
5. 补 release notes / changelog discipline

完成标准：

- 从 tag/release 到 npm public package 全链路真实成功
- GitHub Release asset、npm package、README 用法保持一致
- 失败时能明确知道是 build、pack、publish 还是 registry 权限问题

### B. Real-World Acceptance

目标：

- 把 acceptance 从“模块样本集合”推进成“真实任务剧本集合”
- 让 acceptance 成为日常判断主线是否退化的第一读数

剩余工作：

1. 继续扩充真实任务 runbook，重点是跨 browser / recovery / context / operator 的同场景剧本
2. 把私有清洗 fixture 持续映射到 `realworld / acceptance / soak` catalog
3. 为每条 runbook 增加跨面不变量断言
4. 形成 smoke / nightly / weekly 三层 acceptance 组合
5. 让 acceptance 输出更容易区分是 browser、recovery、context、operator 哪一层先退化

完成标准：

- 有一组稳定的 canonical runbook 覆盖主要真实任务 archetype
- PR smoke 和 nightly 验证各自职责清楚
- 同一个 incident 在 replay / runtime / operator 三面的一致性有固定断言

### C. Long Soak And Stability Operations

目标：

- 把 soak 从“能跑几次”推进成“长期有读数、有失败聚类、有回归意义”

剩余工作：

1. 固化 nightly soak 频率和 selector 组合
2. 增加 soak 结果摘要与失败 bucket 聚类
3. 区分 flaky、known issue、new regression
4. 为高成本场景定义固定循环数和保底样本
5. 把 soak 输出接到 operator/review 习惯里，而不是只留在日志

完成标准：

- soak 不再只是一次性命令，而是持续运行机制
- 每次失败都能落到明确 bucket
- 可以稳定回答“最近一周主链是否更稳”

### D. Failure Taxonomy And Operator Polish

目标：

- 把 recovery / replay / triage 的最后一轮 operator-facing polish 收住
- 让失败后更像工单系统，而不是日志拼盘

剩余工作：

1. failure taxonomy 再补细一点的 real-world bucket
2. 统一术语：gate、next action、allowed actions、case state、browser outcome
3. operator triage 排序策略继续打磨
4. recommendation / next-step 文案继续收口
5. 把 release / validation / soak 失败也纳入 operator 视角

完成标准：

- 不看源码，靠 triage / replay / recovery run 就能完成一轮排障
- 失败 bucket 能直接指导 retry、fallback、resume、stop

### E. Browser And Context Steady-State Expansion

目标：

- 继续扩大最容易拖垮真实任务的两条主链：browser continuity 与 context continuity

剩余工作：

1. browser 的长链 real-world 样本继续扩大
2. reconnect / eviction / reclaim / ref isolation 的长期稳定性继续验证
3. context 在高压 budget 下的 carry-forward 继续压测
4. retrieved memory / worker evidence / recent turns 的 packing 行为继续对齐 acceptance
5. 对 prompt-console / runtime query 的解释性输出继续打磨

完成标准：

- 长任务中断后，大部分 browser 场景可预测恢复
- 高压上下文下，pending / waiting / blocker / decisions 不会轻易丢

### F. Phase 2 Preparation

目标：

- 为下一阶段 kernel lift 做边界准备，但不提前开工大重构

准备项：

1. durable execution journal 的边界文档
2. context compiler / memory ledger 的边界文档
3. tool policy kernel 的接口前提
4. typed delegation / work package / merge gate 的进一步抽象前提
5. trace / eval / regression 的下一阶段目标定义

完成标准：

- 能清楚说出 Phase 2 为什么做、做什么、不做什么
- 不把 Phase 2 的抽象提前污染 Phase 1 的收尾工作

## 4. 推荐执行顺序

当前建议严格按下面顺序推进：

1. 真实 public release 演练
2. real-world acceptance 持续做厚
3. nightly / weekly soak 制度化
4. failure taxonomy 与 operator polish 最后一轮收口
5. browser/context 稳态样本继续扩大
6. 只在前五项稳定后，再进入 Phase 2 准备的正式设计收束

## 5. 不建议现在做的事

当前不建议启动：

- Electron shell
- 大规模桌面 GUI
- durable execution kernel 正式实现
- ContextCompiler 正式替换现有 prompt/context pipeline
- 重写 worker/runtime 主契约

这些都应该等到：

- release 闭环跑通
- acceptance / soak 有持续读数
- failure/operator 视图稳定

之后再决定。

## 6. Phase 1 Exit Criteria

只有同时满足下面条件，Phase 1 才算真正收住：

1. public release 链路真实跑通至少一轮
2. real-world acceptance 有稳定 canonical runbook 集
3. nightly / scheduled soak 有稳定运行和失败 bucket
4. operator triage / replay / recovery 输出足够支持一轮独立排障
5. browser / context 主链没有明显未收口的高频退化点

## 7. Immediate Backlog

最短路径 backlog：

1. 配置 `NPM_TOKEN` 并执行第一次真实 release
2. 选择一组固定的 smoke acceptance selectors
3. 为 soak 结果加失败 bucket 摘要
4. 再补一轮 real-world runbook，优先覆盖 publish / browser research / operator escalation
5. 把 release / soak / acceptance 的结果读数整理成一个统一 operator 入口

## 8. Agent Handoff

可直接交给下一个 agent 的 handoff：

```text
当前主仓库是 /Users/chris/workspace/turnkeyai，只在这个仓库继续工作，不要改 archive 仓库，也不要重新引入 accio / claude code 字样。

截至 2026-04-04，Phase 1 的核心机制已经完成，主线不再是新增 kernel，而是收口四类工作：
1. public release / npm publish 闭环验证
2. real-world acceptance 持续做厚
3. nightly / weekly soak 制度化与失败 bucket
4. failure taxonomy / replay / recovery / operator triage 的最后一轮 polish

已完成：
- browser / recovery / context / operator / validation 主机制
- realworld / acceptance / soak / failure / regression catalog 第一版
- model catalog + chain catalog 第一版
- release readiness / soak workflow 第一版

当前最优先下一步：
- 配置 NPM_TOKEN，跑第一次真实 public release
- 同时继续扩 real-world acceptance canonical runbook
- 把 soak 输出变成可持续读数，而不是一次性命令

工作时优先看这些文档：
- docs/design/future-work-master-plan.md
- docs/MILESTONES.md
- docs/design/phase1-productization-matrix.md
- docs/design/production-hardening-gap-map.md

执行原则：
- 不扩新主线
- 不急着做 Electron / GUI / Phase 2 kernel
- 优先提升真实任务成功率、可诊断性、发布可信度
```
