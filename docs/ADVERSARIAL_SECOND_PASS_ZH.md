# TurnkeyAI 二次深度对抗审查报告 (Second-Pass Adversarial Review)

基于对长效代理会话（Long-running sessions）、浏览器驱动工作流（Browser-backed workflows）、故障恢复（Recovery）以及运维级重放审计（Operator debugging/replay）的严肃生产级设定，特进行二次深度审查。

本报告摒弃代码风格与低优先级问题，直接回答与系统生死存亡相关的十大核心架构拷问。

---

### 1. 本系统依赖但在执行上毫无保障的 5 个不变性 (Invariants)
1.  **文件写入原子性与无冲突假设 (Atomic Writes without Conflict Resolution)**：系统极其依赖 `writeJsonFileAtomic` 完成全量状态覆盖，却完全没有 `ETag` 或递增乐观锁的版本校验。在多并发回调触发时，很容易产生“后写入但携带旧状态“（Lost Update）的情况。
2.  **会话溯源的一致性 (Session Ancestry Consistency)**：系统假定 Worker 死掉或断开后，`browserSessionId` 的生命周期能优雅进入关闭/挂起态，并在 HistoryStore 留有记录；但若由于内存溢出或宿主机宕机直接掐断 Node.js 进程，游离（Orphaned）的浏览器 session 会长久存活且在 Daemon 重启时丢失对其所有权的追踪记录。
3.  **心跳即存活 (Heartbeat == Liveness) 的天真假设**：`InMemoryWorkerRuntime` 强依赖执行期间的心跳。但在高 I/O 拥塞（如大量的 FS 写库）导致 Event Loop 大排队时，健康的心跳响应会被阻塞，导致错误地判定 Worker 超时并提前切断上下文重置。
4.  **FlowLedger 与 RuntimeChain 的绝对同步**：假定业务流转节点 (Handoff) 和 执行日志 (Chain) 是完美绑定的。然而由于它们处于两份独立依靠 IO 的文件中存储，一旦其中任何一方因为系统拒绝服务（磁盘满等）写入失败，逻辑状态与可视化审计线将陷入脑裂。
5.  **Relay Peer 承载能力的静态预期**：假设挂载上去具备特定 Capabilities 的目标连接（Peer）能够完整、恒定地支撑当前整个 Flow；系统缺乏对中途掉线的优雅处理和 Peer 降级自动转移能力，会导致当前长期会话整个坍塌。

### 2. 最危险的 5 个架构卡脖子节点 (Architectural Choke Points)
1.  **`packages/app-gateway/src/daemon.ts`**：典型的上帝对象（God Object），在此强耦合了 HTTP 路由、Stores 的初始化、Worker 的调度与浏览器桥接；是任何崩溃的最终聚合受害者。
2.  **`packages/team-runtime/src/coordination-engine.ts`**：内部过分依赖 `KeyedAsyncMutex` 加锁。这意味着所有的交接调度逻辑被退化成极简串行执行。长时间运行的同步任务会引发整个队列塞车。
3.  **`packages/browser-bridge/src/transport/relay-adapter.ts`**：巨无霸文件，包揽了 Peer 的查找、附着逻辑、快照落地和 CDPs 调用，是当前系统测试最常失败的高危灾区。
4.  **`packages/core-types/src/file-store-utils.ts`**：所有系统的心跳——每一次微小的状态改变，都要经过这个简陋的 filesystem 操作漏斗。
5.  **`packages/role-runtime/src/policy-role-runtime.ts`**：与 LLM 通讯强捆绑的地方，如果遇到大批量 Prompt/History 的编解码，会极大地占用 CPU 甚至是爆库。

### 3. 哪里打着“持久化运行”的幌子，其实只有“临时恢复启发式算法”？ (Durable Execution vs. Resumability Heuristics)
系统在 **Browser Transport (浏览器连接恢复)** 与 **Worker Continuation (任务中断继续)** 层面充斥着启发式恢复：
- 系统所谓的 `hot` / `warm` / `cold` 恢复模式，本质上只是靠比对 `transportSessionId` 缓存或目标 URL 是否一致。如果一个网页里的长任务表单填了一半，Daemon 宕机重启后通过启发式算法“认出了”那个处于一半状态的 Page，它**并不知道表单填到了哪里**，也没有记录 DOM Tree Mutability 进度。
- 等待 Worker Resume 的 `continuationDigest` 其实只是暂存了上一步执行后的内存快照指纹。如果上下文因为浏览器发生异步漂移（如超时回退了重定向），这部分执行恢复就毫无逻辑可言，它只能硬逼 LLM 从新的视觉截屏中“猜”自己应该怎么往下走，而不是真正的状态机级别恢复。

### 4. Replay / Recovery / Operator Summary 在哪些场景下会与真实现网状态产生分歧？ (Truth Disagreement)
- **不可撤销外部操作后的死亡鸿沟**：如果 Relay 网关向真实网页下达了 `click` 购买按钮的操作并执行成功，但在 Relay 结果回传并往 `HistoryStore` 与 `RuntimeChain` 写磁盘之前，主 Daemon 宕机了。
  - **Operator Summary**：显示“尚未点击，执行被中断”。
  - **Recovery**：会重试再次生成 click 意图，引发二次点击或报错。
  - **真实的 Runtime（真实世界浏览器）**：已经完成了购买跳转。

### 5. 系统中深藏的隐性耦合 (Hidden Coupling Points)
- **Daemon 与存储实现的强耦合**：尽管定义了 `*Store` 接口，但大量报错处理依赖了底部的 `ENOENT` Exception 假设（隐形锁定平台一定是以 File Base 作为支撑）。
- **浏览器上下文与编排器越界通信**：BrowserTransport 频繁返回底层的 `BrowserSnapshotResult` 和 Playwright trace paths 一直渗透流到最上层的 Runtime Inspector（甚至跨越了角色抽象），这让上层编排直接被浏览器的渲染架构特征绑定。
- **配置环境常量的乱窜**：LLM 凭据和基础路径（Base URLs）高度依赖 `process.env`，而非环境依赖注入，这让 `daemon.ts` 成了环境变数的深水炸弹。

### 6. 一旦加入新 Worker 或开启远程执行，哪些抽象会最先瓦解？ (First Abstractions to Collapse on Scale)
- **`InMemoryWorkerRuntime`**：该抽象假定了调度器和工作线程分享同一进程内的执行上下文、毫无延迟障碍且一定以近乎同步（或极短的异步 Promise）完成调度交接。一旦涉足远程节点，该模型会被诸如网络分区问题、脑裂选主、请求响应重试等因素直接压垮。
- **`coordination-engine.ts` 内的 `KeyedAsyncMutex`**：如果你在一个 Key 上的任务是被派发到一个 10秒延迟的外部 Worker 节点，整个相关线程在当前节点就被锁死，资源池利用率瞬间跌到谷底。

### 7. 哪些数据结构必须立刻跃升为强类型的领域契约？ (Explicit Domain Contracts Needed)
1.  **`HandoffEnvelope` (交接信封)**：跨角色的生命线。目前承载的 payload 过于松散，一旦发生跨服务的 Actor 分发，必须升维成具备 Schema 验证、TTL 和重试次数记录的严格事件总线契约。
2.  **`BrowserActionTrace` / `RelayActionRequest`**：必须升阶为带版本号的 RPC 契约 (例如 protobuf 等形式)。随着 CDP 标准或浏览器指纹反扒工具更新，当前基于宽松对象的传递势必会在某次版本更新中大规模破坏兼容性。
3.  **`ContinuationDigest`**：中断指纹，必须具备强解耦的结构化状态快照签名，否则反序列化黑盒是跨节点重构的大患。

### 8. 应该转换为 Append-Only Journal，哪些又该保留 Projection 形态？ (Journaling vs. Projections)
目前几乎所有的状态都是全量覆盖（CRUD 视角），必须进行职责划分：
- **【必须转为 Append-Only Event Journal】**:
  - `RuntimeChain` （运行记录本）
  - `FlowLedger` （状态迁跃必须作为一系列事件处理：如 `[FlowStarted, RoleHandedOff, TaskCompleted]`）
  - `BrowserSessionHistoryEntry` （天然就是日志）
- **【保留为 Projection (投射/计算视图)】**:
  - 当前具体的 `TeamThread` 会话最新视图。
  - 当前保持激活状态的 `BrowserTarget` 映射表。
  - `BrowserProfileStore` 缓存偏好等。

### 9. 能够产出最大化 ROI （投入产出比）的三大重构战役 (Top 3 Refactors)
1. **拥抱事件溯源 (Event-Sourced Core Transition)**
   将 `FlowLedger` 和 `RuntimeChain` 从并发替换 `writeJsonFileAtomic` 改造为主流的 Event Queue + Append-log Store。极大降低并发操作带来的 I/O 悲观锁争抢。
2. **事件总线与控制流解耦 (Async State Decoupling)**
   移除 `CoordinationEngine` 中的巨型 `KeyedAsyncMutex`。改用真正的内存异步事件循环或外部流来分发 `HandoffEnvelope`；彻底分离“命令意图解析”和“物理状态落地”的同步等待链条。
3. **肢解 `daemon.ts` 聚合体 (Dismantle the God Object)**
   解拆 HTTP 网关 API 暴露、Worker 调度注册表和底层存储的注入配置。使得网关无状态化（Stateless），完全凭借后面的执行引擎工作，这能大大改善因单个模块崩溃拖死整个工作台的问题，也能大幅降低单测复杂难度。

### 10. 如果我是主心骨（Maintainer），基础未夯实前我会拔剑阻止哪些功能迭代？ (Feature Embargo)
在上述基础清理干净之前，我要绝对拒绝研发以下功能（并锁定相关 PR）：
🚫 **多节点集群/跨物理机远程 Worker 的扩展 (Multi-node Daemon clustering)**：基于当下的 Mutex 和 File-backed store，在多节点上运行必定是脑裂与并发写入覆盖的坟墓。
🚫 **所有新的长连接 Transport（比如云端群控 Headless Browsers、移动端 Android UIA2 集成）**：连 `relay-adapter` 现在面对简单断网重连边界处理都在吃瘪，强上新平台只会让错误排查成本指数级攀升。
🚫 **任何尝试在目前引擎上构建的 “多智能体蜂群” 协同（Swarm-based tasks）**：当前文件系统的 IOPS 以及 `RequestEnvelopeGuard` 的静态限制将让系统还没发挥真正的协同智能就被自身存储队列挤干崩溃。 

---
### 推荐操作路线图 (Recommended Order of Operations)
1. 建立以 `sqlite` 作为中间态的 Event Journal Store。
2. 剥除所有阻塞型大锁（`KeyedAsyncMutex` 改造事件队列调度）。
3. 增加与巩固所有与外部（浏览器）通信前后的 **Write-Ahead Log (WAL)** 的原子性对齐能力。
4. 解散、细化分解 `daemon.ts`。
