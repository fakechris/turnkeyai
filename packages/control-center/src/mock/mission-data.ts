// Mock data for the Mission Control shell.
//
// PR K1 — original purpose: full local fixture so the dashboard renders
// before the daemon has any mission stores.
//
// PR K2 — current purpose: OFFLINE FALLBACK. Each page that previously
// imported MOCK_DATA directly now consumes useMissions/useWorkItems/etc
// from src/api/useMissionData.ts and only falls back to MOCK_DATA while
// loading, on fetch failure, or when the daemon hasn't been bootstrapped
// (operator can hit "Load demo missions" on the Missions page to seed).
//
// Types: re-exported from src/api/mission-api.ts so the fallback shape
// matches the live shape exactly — adding a new field on the daemon side
// + the api types module is enough; the mock auto-conforms.

import type {
  ActivityEvent as ApiActivityEvent,
  Agent as ApiAgent,
  ApprovalRequest as ApiApprovalRequest,
  ApprovalRow,
  ContextSource as ApiContextSource,
  Mission as ApiMission,
  WorkItem as ApiWorkItem,
} from "../api/mission-api";

// Re-export the API types under the old mock-data names so existing
// page imports don't break.
export type Mission = ApiMission;
export type WorkItem = ApiWorkItem;
export type Agent = ApiAgent;
export type ContextSource = ApiContextSource;
export type ActivityEvent = ApiActivityEvent;
export type ApprovalRequest = ApiApprovalRequest;
export type ContextKind = ApiContextSource["kind"];
export type ColorTag = ApiAgent["color"];
export type Severity = ApiApprovalRequest["severity"];

import type { MissionStatus } from "../state/types";

// ── Local-only types not yet on the daemon ───────────────────────────
// RecoveryCase, AgentPreset, RuntimeMetric/Session/Log: K1 surfaces
// that don't have backing stores yet. K3 wires recovery to real cases
// (from the existing recovery-action-service); K4 wires presets through
// /daemon/agent-connect/presets. Keeping these as local types so the
// dashboard renders something today.

export interface RecoveryCase {
  id: string;
  bucket: string;
  mission: string;
  workItem: string;
  agent: string;
  title: string;
  cn: string;
  explanation: string;
  firstSeen: string;
  attempts: number;
  nextAction: string;
  requiresApproval: boolean;
  runtime: { transport: string; lastError: string; peer: string };
}

// ── Agent Connect presets ─────────────────────────────────────────────
export interface AgentPreset {
  id: string;
  name: string;
  note: string;
  state: "connected" | "ready" | "not-connected";
  color: ColorTag;
}

// ── Runtime metrics ───────────────────────────────────────────────────
export interface RuntimeMetric {
  l: string;
  v: string;
  d: string;
}

export interface RuntimeSession {
  id: string;
  target: string;
  transport: string;
  state: string;
  duration: string;
  pid: string;
}

export interface RuntimeLogLine {
  ts: string;
  sev: "ok" | "warn" | "err";
  src: string;
  msg: string;
}

export interface RuntimeData {
  daemonStarted: string;
  transport: { kind: string; health: string };
  metrics: RuntimeMetric[];
  sessions: RuntimeSession[];
  logs: RuntimeLogLine[];
}

// ── Combined dataset ──────────────────────────────────────────────────
export interface MockData {
  agents: Agent[];
  contextSources: ContextSource[];
  workItems: WorkItem[];
  approvals: ApprovalRequest[];
  recoveries: RecoveryCase[];
  timeline: ActivityEvent[];
  missions: Mission[];
  runtime: RuntimeData;
  presets: AgentPreset[];
}

// The dataset — translated 1:1 from the design's data.js. Strings (incl.
// the bilingual zh-CN copy) preserved so the design's visual rhythm is
// reproduced. Stored as RAW_MOCK; the exported MOCK_DATA wraps it to add
// the type-required `id`/`missionId`/`*Ms` fields that the daemon also
// emits, so the fallback data conforms to mission-api types.
const RAW_MOCK = {
  agents: [
    {
      id: "agent.coord",
      name: "Coordinator",
      nameCn: "调度 Agent",
      role: "Coordinator",
      provider: "Claude Code",
      providerNote: "claude-sonnet-4.5 · local bridge",
      status: "working",
      ava: "Co",
      color: "info",
      capabilities: ["plan", "delegate", "review.plan"],
      missions: 1,
      tokensIn: "182.4k",
      tokensOut: "11.2k",
    },
    {
      id: "agent.research",
      name: "Research Agent",
      nameCn: "调研 Agent",
      role: "Researcher",
      provider: "Codex",
      providerNote: "gpt-5.1-pro · operator scope",
      status: "working",
      ava: "Re",
      color: "accent",
      capabilities: ["search.web", "browser.read", "doc.read"],
      missions: 1,
      tokensIn: "94.8k",
      tokensOut: "38.1k",
    },
    {
      id: "agent.browser",
      name: "Browser Operator",
      nameCn: "浏览器 Agent",
      role: "Browser",
      provider: "TurnkeyAI Worker",
      providerNote: "local · direct-CDP",
      status: "needs_approval",
      ava: "Br",
      color: "warning",
      capabilities: ["browser.navigate", "browser.click", "browser.form", "browser.snapshot"],
      missions: 1,
      tokensIn: "—",
      tokensOut: "—",
    },
    {
      id: "agent.doc",
      name: "Doc Agent",
      nameCn: "文档 Agent",
      role: "Document",
      provider: "Kimi",
      providerNote: "k2-128k · operator scope",
      status: "working",
      ava: "Dc",
      color: "success",
      capabilities: ["doc.read", "doc.write.approval", "diff"],
      missions: 1,
      tokensIn: "62.0k",
      tokensOut: "29.5k",
    },
    {
      id: "agent.review",
      name: "Reviewer",
      nameCn: "审校 Agent",
      role: "Reviewer",
      provider: "Claude Code",
      providerNote: "claude-haiku-4.5 · read scope",
      status: "planning",
      ava: "Rv",
      color: "info",
      capabilities: ["consistency.check", "citation.check"],
      missions: 1,
      tokensIn: "14.1k",
      tokensOut: "3.6k",
    },
    {
      id: "agent.recovery",
      name: "Recovery Agent",
      nameCn: "恢复 Agent",
      role: "Recovery",
      provider: "TurnkeyAI Daemon",
      providerNote: "local · operator",
      status: "draft",
      ava: "Rc",
      color: "danger",
      capabilities: ["session.reattach", "diagnostics", "replay"],
      missions: 0,
      tokensIn: "—",
      tokensOut: "—",
    },
  ],

  contextSources: [
    {
      id: "ctx.browser.notion",
      kind: "browser",
      title: "notion.so/pricing",
      cn: "Notion 定价页",
      url: "https://www.notion.so/pricing",
      state: "attached",
      lastUse: "00:01:14 ago",
      transport: "direct-CDP",
      session: "sess_8f2e",
    },
    {
      id: "ctx.browser.reflect",
      kind: "browser",
      title: "reflect.app/pricing",
      cn: "Reflect 定价页",
      url: "https://reflect.app/pricing",
      state: "detached",
      lastUse: "00:04:32 ago",
      transport: "relay",
      session: "sess_2a91",
    },
    {
      id: "ctx.browser.mem",
      kind: "browser",
      title: "get.mem.ai",
      cn: "Mem 主站",
      url: "https://get.mem.ai/pricing",
      state: "attached",
      lastUse: "00:00:21 ago",
      transport: "direct-CDP",
      session: "sess_5d1c",
    },
    {
      id: "ctx.doc.draft",
      kind: "doc",
      title: "competitor-matrix.md",
      cn: "对比矩阵 草稿",
      url: "~/turnkey/research/competitor-matrix.md",
      state: "watching",
      lastUse: "00:00:08 ago",
      writer: "agent.doc",
    },
    {
      id: "ctx.folder.research",
      kind: "folder",
      title: "~/turnkey/research/2026-05-competitors",
      cn: "调研文件夹",
      url: "~/turnkey/research/2026-05-competitors",
      state: "read-only",
      lastUse: "00:02:11 ago",
      counts: { files: 24, snapshots: 11, screenshots: 7 },
    },
    {
      id: "ctx.api.serper",
      kind: "api",
      title: "Serper.dev search",
      cn: "Web 搜索 API",
      url: "https://api.serper.dev/search",
      state: "ready",
      lastUse: "00:00:42 ago",
      writer: "agent.research",
    },
    {
      id: "ctx.desktop.figma",
      kind: "desktop",
      title: "Figma — Comparison Whiteboard",
      cn: "Figma 看板（仅观察）",
      url: "macOS 14.5 · window 0x4cb2",
      state: "approval-gated",
      lastUse: "—",
    },
  ],

  workItems: [
    {
      n: 1,
      id: "wi.plan",
      title: "Plan mission decomposition",
      cn: "拆解：5 个竞品 × 3 个维度（定价 · AI 能力 · 协作）",
      agent: "agent.coord",
      status: "done",
      started: "09:31:04",
      duration: "00:01:48",
      contextRefs: [],
      output: "8 work items · 5 agents",
    },
    {
      n: 2,
      id: "wi.notion",
      title: "Research · Notion AI",
      cn: "调研：Notion AI",
      agent: "agent.research",
      status: "working",
      started: "09:33:01",
      duration: "00:41:09",
      contextRefs: ["ctx.browser.notion", "ctx.api.serper"],
      output: "已采集 6 条证据 · 2 处待核对",
      progress: 0.62,
    },
    {
      n: 3,
      id: "wi.reflect",
      title: "Research · Reflect",
      cn: "调研：Reflect",
      agent: "agent.research",
      status: "blocked",
      started: "09:42:18",
      duration: "00:32:01",
      blocker: "recovery.session-detached",
      contextRefs: ["ctx.browser.reflect"],
      output: "采集中断 · recovery 1 次",
    },
    {
      n: 4,
      id: "wi.mem",
      title: "Research · Mem",
      cn: "调研：Mem",
      agent: "agent.research",
      status: "working",
      started: "09:48:55",
      duration: "00:25:14",
      contextRefs: ["ctx.browser.mem"],
      output: "AI 自动整理：已捕获 3 条权益条款",
      progress: 0.4,
    },
    {
      n: 5,
      id: "wi.verify-pricing",
      title: "Verify pricing · live submit",
      cn: "实地核对定价 · 需提交表单",
      agent: "agent.browser",
      status: "needs_approval",
      started: "10:11:33",
      duration: "00:02:51",
      contextRefs: ["ctx.browser.notion"],
      output: "在 /pricing 页提交团队规模 5 人，以查看团队套餐价",
      approvalId: "ap.notion-form",
    },
    {
      n: 6,
      id: "wi.draft",
      title: "Draft comparison document",
      cn: "撰写对比文档",
      agent: "agent.doc",
      status: "working",
      started: "10:02:19",
      duration: "00:12:05",
      contextRefs: ["ctx.doc.draft", "ctx.folder.research"],
      output: "已写入 §1 §2 §3 · 等待数据补全 §4",
      progress: 0.55,
    },
    {
      n: 7,
      id: "wi.review",
      title: "Reviewer pass · citations + consistency",
      cn: "审校：引用与一致性检查",
      agent: "agent.review",
      status: "planning",
      started: "—",
      duration: "—",
      contextRefs: ["ctx.doc.draft"],
      output: "等待 §4 完成",
    },
    {
      n: 8,
      id: "wi.export",
      title: "Export final report bundle",
      cn: "导出最终报告（含证据 zip）",
      agent: "agent.coord",
      status: "draft",
      started: "—",
      duration: "—",
      contextRefs: [],
      output: "—",
    },
  ],

  approvals: [
    {
      id: "ap.notion-form",
      severity: "med",
      mission: "msn.01",
      missionTitle: "竞品调研：五款 prosumer 笔记应用",
      agent: "agent.browser",
      action: "browser.form.submit",
      title: "Submit pricing form on notion.so/pricing",
      cn: "在 notion.so/pricing 提交团队规模表单（5 人）以查看团队套餐价格",
      affects: ["ctx.browser.notion"],
      risk: "向第三方站点提交表单 · 可能触发 captcha · 非幂等",
      requestedAt: "10:11:33",
      requestedAgo: "00:00:51 ago",
      policyHint: "browser.form.submit 默认需要审批",
    },
    {
      id: "ap.doc-write-section4",
      severity: "low",
      mission: "msn.01",
      missionTitle: "竞品调研：五款 prosumer 笔记应用",
      agent: "agent.doc",
      action: "doc.write",
      title: "Append §4 to competitor-matrix.md",
      cn: "向 competitor-matrix.md 追加 §4「协作与多 Agent 能力」段落（约 480 字）",
      affects: ["ctx.doc.draft"],
      risk: "覆盖本地草稿 · 可回滚（已自动 snapshot）",
      requestedAt: "10:12:04",
      requestedAgo: "00:00:20 ago",
      policyHint: "doc.write 在 ~/turnkey/research/** 默认需审批",
    },
    {
      id: "ap.desktop-figma",
      severity: "high",
      mission: "msn.04",
      missionTitle: "Vendor portal 监控 · ACME 物流",
      agent: "agent.browser",
      action: "desktop.window.read",
      title: "Read Figma window content",
      cn: "读取本机 Figma 窗口可见内容用于核对画板状态（仅截图，不交互）",
      affects: ["ctx.desktop.figma"],
      risk: "桌面级访问 · 即便只读也提示用户确认",
      requestedAt: "09:58:11",
      requestedAgo: "00:14:13 ago",
      policyHint: "desktop.* 总是需要审批",
    },
  ],

  recoveries: [
    {
      id: "rc.reflect-detach",
      bucket: "browser.session.detached",
      mission: "msn.01",
      workItem: "wi.reflect",
      agent: "agent.browser",
      title: "Browser session detached",
      cn: "Research Agent 抓取 Reflect 定价证据时浏览器会话掉线",
      explanation:
        "Direct-CDP 隧道在 09:55 心跳超时，relay 备援尝试重新挂载失败 1 次。最近一次操作（snapshot pricing 模块）可能已执行——重试存在重复抓取的风险。",
      firstSeen: "09:55:42",
      attempts: 1,
      nextAction: "reattach via relay",
      requiresApproval: true,
      runtime: { transport: "relay", lastError: "WS 1006 · pong timeout 12s", peer: "tk-relay-sea1" },
    },
  ],

  timeline: [
    { t: "09:31:04", day: "今天 · TUE 17 MAY 2026", kind: "plan", actor: "agent.coord", text: "Created mission · 解析输入「调研五款笔记应用…」并提议 8 个 work items。", tags: ["plan"] },
    { t: "09:32:18", kind: "tool", actor: "agent.coord", text: "Delegated · WI-2/3/4 → Research Agent · WI-6 → Doc Agent · WI-7 → Reviewer。", tags: ["delegate"] },
    { t: "09:33:01", kind: "thought", actor: "agent.research", text: "我先抓 Notion 的官方定价页与 AI 套件 SKU 表，列出 4 个维度后再继续。" },
    { t: "09:33:14", kind: "browser", actor: "agent.research", target: "ctx.browser.notion", text: "Opened browser session → <b>notion.so/pricing</b>。", runtime: { tab: "notion · tab #4", transport: "direct-CDP", session: "sess_8f2e", bytes: "1.2 MB" } },
    { t: "09:33:22", kind: "browser", actor: "agent.research", target: "ctx.browser.notion", text: "Snapshot captured · DOM 312 nodes · pricing-table 模块已锁定。", evidence: [{ kind: "snapshot", id: "snap_a31", label: "snap_a31.json" }, { kind: "screenshot", id: "shot_a31", label: "pricing@2x.png" }], tags: ["snapshot"] },
    { t: "09:35:09", kind: "thought", actor: "agent.research", text: "团队套餐价隐藏在表单后 · 标记为「待核对」继续推进 Reflect。" },
    { t: "09:42:18", kind: "browser", actor: "agent.research", target: "ctx.browser.reflect", text: "Navigated → <b>reflect.app/pricing</b>。", runtime: { tab: "reflect · tab #6", transport: "direct-CDP", session: "sess_2a91", bytes: "640 kB" } },
    { t: "09:48:55", kind: "browser", actor: "agent.research", target: "ctx.browser.mem", text: "Navigated → <b>get.mem.ai/pricing</b>。", runtime: { tab: "mem · tab #7", transport: "direct-CDP", session: "sess_5d1c", bytes: "812 kB" } },
    { t: "09:51:30", kind: "doc", actor: "agent.doc", target: "ctx.doc.draft", text: "Opened watcher → <code>competitor-matrix.md</code>。已建立基线 snapshot <code>doc_b3</code>。" },
    { t: "09:55:42", kind: "recovery", actor: "agent.browser", target: "ctx.browser.reflect", text: "Browser session <b>detached</b> · WS 1006 · pong timeout。Recovery Agent 已挂起 WI-3。", emph: "danger", tags: ["recovery"], runtime: { bucket: "browser.session.detached", peer: "tk-relay-sea1", attempt: "1/3" } },
    { t: "09:56:01", kind: "thought", actor: "agent.recovery", text: "最近一次操作 <code>browser.snapshot</code> 可能已执行——不自动重试。提示用户决定。" },
    { t: "10:02:19", kind: "doc", actor: "agent.doc", target: "ctx.doc.draft", text: "Drafted §1 §2 §3 · 写入 480 行 · diff 已保存。", emph: "success", evidence: [{ kind: "diff", id: "diff_c1", label: "draft @ rev 7" }], runtime: { writer: "agent.doc", bytes: "+12.8 kB" } },
    { t: "10:03:44", kind: "tool", actor: "agent.research", target: "ctx.api.serper", text: 'Search · <code>"Mem AI" pricing teams 2026</code> · 12 results。' },
    { t: "10:05:01", kind: "browser", actor: "agent.research", target: "ctx.browser.notion", text: "Extracted 6 pricing claims · 团队价仍待表单提交。", evidence: [{ kind: "extract", id: "ex_n1", label: "notion_pricing.json" }] },
    { t: "10:08:10", kind: "thought", actor: "agent.research", text: "为得到团队套餐准确价，需要提交团队规模 5 人——这一步是非幂等，需用户审批。" },
    { t: "10:11:33", kind: "approval", actor: "agent.browser", target: "ctx.browser.notion", text: "Requested approval · <b>browser.form.submit</b> · notion.so/pricing。", emph: "warn", tags: ["needs_approval"], approvalId: "ap.notion-form" },
    { t: "10:11:48", kind: "tool", actor: "agent.coord", text: "Mission state → <b>needs_approval</b> · 暂停 WI-5。其余 work items 继续。" },
    { t: "10:12:04", kind: "approval", actor: "agent.doc", target: "ctx.doc.draft", text: "Requested approval · <b>doc.write</b> · 追加 §4 协作能力（480 字）。", emph: "warn", tags: ["needs_approval"], approvalId: "ap.doc-write-section4" },
    { t: "10:12:32", kind: "browser", actor: "agent.research", target: "ctx.browser.mem", text: "Snapshot captured · 抓取 pricing FAQ。", evidence: [{ kind: "snapshot", id: "snap_m9", label: "snap_m9.json" }] },
    { t: "10:13:19", kind: "thought", actor: "agent.review", text: "提前扫一遍 §1-§3：发现 1 处引用缺失（Reflect Backlinks AI 段无 citation）。" },
    { t: "10:13:55", kind: "artifact", actor: "agent.research", text: "Artifact registered · <code>evidence/notion_pricing.json</code> · 11 KB · sha 4c1d。", evidence: [{ kind: "json", id: "art_1", label: "notion_pricing.json" }] },
    { t: "10:14:02", kind: "tool", actor: "agent.coord", text: "Awaiting your decision · 2 pending approvals · WI-3 blocked。" },
  ],

  missions: [
    {
      id: "msn.01",
      shortId: "MSN-1042",
      title: "竞品调研：五款 prosumer 笔记应用",
      titleEn: "Competitive research · 5 prosumer note apps",
      desc: "对比 Notion AI / Reflect / Mem / Tana / Capacities 的 AI 能力、定价与多 agent 协作，输出可引用报告。",
      status: "needs_approval",
      mode: "research",
      modeLabel: "Research & summarize",
      owner: "you",
      ownerLabel: "You",
      createdAt: "09:31 · today",
      agents: ["agent.coord", "agent.research", "agent.browser", "agent.doc", "agent.review"],
      progress: 0.42,
      pendingApprovals: 2,
      blockers: 1,
      contextSummary: ["3 browser", "1 doc", "1 folder", "1 api"],
    },
    {
      id: "msn.02",
      shortId: "MSN-1041",
      title: "Vendor portal 监控 · ACME 物流",
      titleEn: "Monitor & update · ACME logistics portal",
      desc: "认证浏览器会话每 15 min 检查发货状态变化并写入本地 tracker.csv。",
      status: "working",
      mode: "monitor",
      modeLabel: "Monitor & update",
      owner: "you",
      ownerLabel: "You",
      createdAt: "今天 07:15",
      agents: ["agent.coord", "agent.browser", "agent.review"],
      progress: 0.78,
      pendingApprovals: 0,
      blockers: 0,
      contextSummary: ["1 browser (auth)", "1 doc"],
    },
    {
      id: "msn.03",
      shortId: "MSN-1040",
      title: "Repo 与设计文档对齐",
      titleEn: "Doc / repo realign",
      desc: "Doc Agent 监听 docs/design/** 并基于最近 24h commit 提议编辑，全部走审批。",
      status: "needs_approval",
      mode: "review",
      modeLabel: "Review & verify",
      owner: "chris",
      ownerLabel: "chris",
      createdAt: "昨天 22:08",
      agents: ["agent.coord", "agent.doc", "agent.review"],
      progress: 0.31,
      pendingApprovals: 4,
      blockers: 0,
      contextSummary: ["repo · turnkeyai", "1 doc"],
    },
    {
      id: "msn.04",
      shortId: "MSN-1039",
      title: "多 Agent 信息汇总：行业 LLM 推理服务化",
      titleEn: "Multi-agent investigation · LLM inference services",
      desc: "并行 3 个 research agents 抓取 Modal / Together / Fireworks 实测数据并合并答案。",
      status: "blocked",
      mode: "investigation",
      modeLabel: "Multi-agent investigation",
      owner: "chris",
      ownerLabel: "chris",
      createdAt: "昨天 14:42",
      agents: ["agent.coord", "agent.research", "agent.review"],
      progress: 0.58,
      pendingApprovals: 0,
      blockers: 2,
      contextSummary: ["3 browser", "2 api"],
    },
    {
      id: "msn.05",
      shortId: "MSN-1038",
      title: "iframe-heavy 流程演练：保险报价表",
      titleEn: "Browser-heavy walkthrough · insurance quote",
      desc: "演练 raw-CDP expert lane · 多 popup / shadow DOM · 全程仅 dry-run。",
      status: "done",
      mode: "browser",
      modeLabel: "Operate browser",
      owner: "you",
      ownerLabel: "You",
      createdAt: "周一 16:30",
      agents: ["agent.browser", "agent.recovery"],
      progress: 1,
      pendingApprovals: 0,
      blockers: 0,
      contextSummary: ["1 browser", "raw-CDP"],
    },
    {
      id: "msn.06",
      shortId: "MSN-1037",
      title: "草稿：内部 OKR 评估辅助",
      titleEn: "Draft · internal OKR review helper",
      desc: "等待连接 Codex admin token · 草稿。",
      status: "draft",
      mode: "custom",
      modeLabel: "Custom",
      owner: "you",
      ownerLabel: "You",
      createdAt: "周一 11:02",
      agents: ["agent.coord"],
      progress: 0,
      pendingApprovals: 0,
      blockers: 0,
      contextSummary: ["—"],
    },
  ],

  runtime: {
    daemonStarted: "07:01:48 · uptime 3h 12m",
    transport: { kind: "direct-CDP available · relay standby", health: "ok" },
    metrics: [
      { l: "Active missions", v: "3", d: "of 12 total" },
      { l: "Active agents", v: "5", d: "1 needs approval" },
      { l: "Browser sessions", v: "3 / 4", d: "1 detached" },
      { l: "Pending approvals", v: "2", d: "1 in 00:00:51" },
      { l: "Recovery cases", v: "1", d: "browser.session.detached" },
      { l: "Tokens (today)", v: "354k", d: "in · 82k out" },
    ],
    sessions: [
      { id: "sess_8f2e", target: "notion.so", transport: "direct-CDP", state: "attached", duration: "00:41:09", pid: "12842" },
      { id: "sess_5d1c", target: "get.mem.ai", transport: "direct-CDP", state: "attached", duration: "00:25:14", pid: "12842" },
      { id: "sess_2a91", target: "reflect.app", transport: "relay", state: "detached", duration: "00:32:01", pid: "—" },
      { id: "sess_4b00", target: "acme-logistics.com", transport: "direct-CDP", state: "attached (auth)", duration: "02:58:00", pid: "12842" },
    ],
    logs: [
      { ts: "10:14:02", sev: "ok", src: "coord", msg: "mission msn.01 → needs_approval (2 pending)" },
      { ts: "10:13:55", sev: "ok", src: "artifact", msg: "registered evidence/notion_pricing.json (11 KB)" },
      { ts: "10:12:04", sev: "warn", src: "policy", msg: "doc.write requires approval (~/turnkey/research/**)" },
      { ts: "10:11:33", sev: "warn", src: "policy", msg: "browser.form.submit requires approval" },
      { ts: "10:08:10", sev: "ok", src: "research", msg: "thought boundary · 26 tokens" },
      { ts: "09:55:42", sev: "err", src: "bridge", msg: "WS 1006 · pong timeout 12s · sess_2a91" },
      { ts: "09:55:41", sev: "warn", src: "bridge", msg: "heartbeat miss · sess_2a91 · 1/3" },
      { ts: "09:48:55", sev: "ok", src: "bridge", msg: "attached sess_5d1c → get.mem.ai (direct-CDP)" },
      { ts: "09:42:18", sev: "ok", src: "bridge", msg: "attached sess_2a91 → reflect.app (direct-CDP)" },
      { ts: "09:33:14", sev: "ok", src: "bridge", msg: "attached sess_8f2e → notion.so (direct-CDP)" },
    ],
  },

  presets: [
    { id: "claude-code", name: "Claude Code", note: "Local · operator scope", state: "connected", color: "info" },
    { id: "codex", name: "Codex (OpenAI)", note: "Local CLI bridge · operator", state: "connected", color: "accent" },
    { id: "comet", name: "Comet", note: "Browser native · relay", state: "ready", color: "success" },
    { id: "kimi", name: "Kimi (Moonshot)", note: "OpenAPI client", state: "connected", color: "success" },
    { id: "custom", name: "Custom OpenAPI client", note: "Token-based · operator", state: "not-connected", color: "muted" },
  ],
};

// Anchor all "*Ms" timestamps to module-load time, offset such that the
// timeline reads "~43 minutes ago". Stable for the life of the page.
const NOW_MS = Date.now();
const TIMELINE_SPAN_MS = 43 * 60 * 1000;
const TIMELINE_T0 = NOW_MS - TIMELINE_SPAN_MS;

// ── Augmented MOCK_DATA ──────────────────────────────────────────────
// Fills in id/missionId/*Ms fields so the raw fixture data conforms to
// mission-api types. The K1 fixture only has a timeline for msn.01;
// every event is stamped with that mission.
//
// The `as` casts are because TS widens RAW_MOCK's literal status / kind
// strings to plain `string` — the runtime shape is still correct, the
// casts just re-narrow back to the mission-api enums.
export const MOCK_DATA: MockData = {
  agents: RAW_MOCK.agents as Agent[],
  contextSources: RAW_MOCK.contextSources as ContextSource[],
  presets: RAW_MOCK.presets as AgentPreset[],
  recoveries: RAW_MOCK.recoveries as RecoveryCase[],
  runtime: RAW_MOCK.runtime as RuntimeData,
  missions: (RAW_MOCK.missions as Omit<Mission, "createdAtMs">[]).map((m) => ({
    ...m,
    createdAtMs: TIMELINE_T0,
  })),
  workItems: (RAW_MOCK.workItems as Omit<WorkItem, "missionId">[]).map((w) => ({
    ...w,
    missionId: "msn.01",
  })),
  approvals: (RAW_MOCK.approvals as Array<Omit<ApprovalRequest, "missionId" | "requestedAtMs"> & { mission: string }>).map(
    ({ mission, ...rest }) => ({
      ...rest,
      missionId: mission,
      requestedAtMs: NOW_MS - 60 * 1000,
    })
  ),
  timeline: (RAW_MOCK.timeline as Array<Omit<ActivityEvent, "id" | "missionId" | "tMs">>).map(
    (e, i) => ({
      ...e,
      id: `ev.mock.${i.toString().padStart(2, "0")}`,
      missionId: "msn.01",
      tMs:
        TIMELINE_T0 +
        Math.round((i / Math.max(1, RAW_MOCK.timeline.length - 1)) * TIMELINE_SPAN_MS),
    })
  ),
};

// ── Lookup helpers ────────────────────────────────────────────────────
export function agentById(id: string): Agent | undefined {
  return MOCK_DATA.agents.find((a) => a.id === id);
}
export function ctxById(id: string): ContextSource | undefined {
  return MOCK_DATA.contextSources.find((c) => c.id === id);
}
export function workItemById(id: string): WorkItem | undefined {
  return MOCK_DATA.workItems.find((w) => w.id === id);
}
export function missionById(id: string): Mission | undefined {
  return MOCK_DATA.missions.find((m) => m.id === id);
}
