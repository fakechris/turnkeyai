// Demo fixtures the daemon writes when /missions/bootstrap-demo is hit.
//
// Translated from the dashboard's MOCK_DATA (packages/control-center/src/
// mock/mission-data.ts), which itself was a 1:1 port of the claude.ai/
// design handoff. Owning the fixture data here so the daemon can serve
// the SAME content that the dashboard used to ship inline — that's what
// lets us swap the dashboard's MOCK_DATA imports for typed API calls
// without changing what users see.
//
// K2 ships ONE fixture mission (msn.01 — the competitive research
// example) plus 5 sketched ones (no rich detail). K3 will start adding
// real missions through user input.

import type {
  ActivityEvent,
  Agent,
  ApprovalRequest,
  ContextSource,
  Mission,
  WorkItem,
} from "@turnkeyai/core-types/mission";

export const DEMO_AGENTS: Agent[] = [
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
];

export const DEMO_CONTEXT_SOURCES: ContextSource[] = [
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
];

const MSN01_ID = "msn.01";

export const DEMO_MISSIONS: Mission[] = [
  {
    id: MSN01_ID,
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
    createdAtMs: 0, // filled in by bootstrap to "now - 43m"
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
    createdAtMs: 0,
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
    createdAtMs: 0,
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
    createdAtMs: 0,
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
    createdAtMs: 0,
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
    createdAtMs: 0,
    agents: ["agent.coord"],
    progress: 0,
    pendingApprovals: 0,
    blockers: 0,
    contextSummary: ["—"],
  },
];

export const DEMO_WORK_ITEMS: WorkItem[] = [
  { id: "wi.plan", missionId: MSN01_ID, n: 1, title: "Plan mission decomposition", cn: "拆解：5 个竞品 × 3 个维度（定价 · AI 能力 · 协作）", agent: "agent.coord", status: "done", started: "09:31:04", duration: "00:01:48", contextRefs: [], output: "8 work items · 5 agents" },
  { id: "wi.notion", missionId: MSN01_ID, n: 2, title: "Research · Notion AI", cn: "调研：Notion AI", agent: "agent.research", status: "working", started: "09:33:01", duration: "00:41:09", contextRefs: ["ctx.browser.notion", "ctx.api.serper"], output: "已采集 6 条证据 · 2 处待核对", progress: 0.62 },
  { id: "wi.reflect", missionId: MSN01_ID, n: 3, title: "Research · Reflect", cn: "调研：Reflect", agent: "agent.research", status: "blocked", started: "09:42:18", duration: "00:32:01", blocker: "recovery.session-detached", contextRefs: ["ctx.browser.reflect"], output: "采集中断 · recovery 1 次" },
  { id: "wi.mem", missionId: MSN01_ID, n: 4, title: "Research · Mem", cn: "调研：Mem", agent: "agent.research", status: "working", started: "09:48:55", duration: "00:25:14", contextRefs: ["ctx.browser.mem"], output: "AI 自动整理：已捕获 3 条权益条款", progress: 0.4 },
  { id: "wi.verify-pricing", missionId: MSN01_ID, n: 5, title: "Verify pricing · live submit", cn: "实地核对定价 · 需提交表单", agent: "agent.browser", status: "needs_approval", started: "10:11:33", duration: "00:02:51", contextRefs: ["ctx.browser.notion"], output: "在 /pricing 页提交团队规模 5 人，以查看团队套餐价", approvalId: "ap.notion-form" },
  { id: "wi.draft", missionId: MSN01_ID, n: 6, title: "Draft comparison document", cn: "撰写对比文档", agent: "agent.doc", status: "working", started: "10:02:19", duration: "00:12:05", contextRefs: ["ctx.doc.draft", "ctx.folder.research"], output: "已写入 §1 §2 §3 · 等待数据补全 §4", progress: 0.55 },
  { id: "wi.review", missionId: MSN01_ID, n: 7, title: "Reviewer pass · citations + consistency", cn: "审校：引用与一致性检查", agent: "agent.review", status: "planning", started: "—", duration: "—", contextRefs: ["ctx.doc.draft"], output: "等待 §4 完成" },
  { id: "wi.export", missionId: MSN01_ID, n: 8, title: "Export final report bundle", cn: "导出最终报告（含证据 zip）", agent: "agent.coord", status: "draft", started: "—", duration: "—", contextRefs: [], output: "—" },
];

export const DEMO_APPROVALS: ApprovalRequest[] = [
  {
    id: "ap.notion-form",
    severity: "med",
    missionId: MSN01_ID,
    missionTitle: "竞品调研：五款 prosumer 笔记应用",
    agent: "agent.browser",
    action: "browser.form.submit",
    title: "Submit pricing form on notion.so/pricing",
    cn: "在 notion.so/pricing 提交团队规模表单（5 人）以查看团队套餐价格",
    affects: ["ctx.browser.notion"],
    risk: "向第三方站点提交表单 · 可能触发 captcha · 非幂等",
    requestedAt: "10:11:33",
    requestedAtMs: 0,
    requestedAgo: "00:00:51 ago",
    policyHint: "browser.form.submit 默认需要审批",
  },
  {
    id: "ap.doc-write-section4",
    severity: "low",
    missionId: MSN01_ID,
    missionTitle: "竞品调研：五款 prosumer 笔记应用",
    agent: "agent.doc",
    action: "doc.write",
    title: "Append §4 to competitor-matrix.md",
    cn: "向 competitor-matrix.md 追加 §4「协作与多 Agent 能力」段落（约 480 字）",
    affects: ["ctx.doc.draft"],
    risk: "覆盖本地草稿 · 可回滚（已自动 snapshot）",
    requestedAt: "10:12:04",
    requestedAtMs: 0,
    requestedAgo: "00:00:20 ago",
    policyHint: "doc.write 在 ~/turnkey/research/** 默认需审批",
  },
  {
    id: "ap.desktop-figma",
    severity: "high",
    missionId: "msn.04",
    missionTitle: "Vendor portal 监控 · ACME 物流",
    agent: "agent.browser",
    action: "desktop.window.read",
    title: "Read Figma window content",
    cn: "读取本机 Figma 窗口可见内容用于核对画板状态（仅截图，不交互）",
    affects: ["ctx.desktop.figma"],
    risk: "桌面级访问 · 即便只读也提示用户确认",
    requestedAt: "09:58:11",
    requestedAtMs: 0,
    requestedAgo: "00:14:13 ago",
    policyHint: "desktop.* 总是需要审批",
  },
];

export const DEMO_TIMELINE: ActivityEvent[] = [
  { id: "ev.01", missionId: MSN01_ID, t: "09:31:04", tMs: 0, day: "今天 · TUE 17 MAY 2026", kind: "plan", actor: "agent.coord", text: "Created mission · 解析输入「调研五款笔记应用…」并提议 8 个 work items。", tags: ["plan"] },
  { id: "ev.02", missionId: MSN01_ID, t: "09:32:18", tMs: 0, kind: "tool", actor: "agent.coord", text: "Delegated · WI-2/3/4 → Research Agent · WI-6 → Doc Agent · WI-7 → Reviewer。", tags: ["delegate"] },
  { id: "ev.03", missionId: MSN01_ID, t: "09:33:01", tMs: 0, kind: "thought", actor: "agent.research", text: "我先抓 Notion 的官方定价页与 AI 套件 SKU 表，列出 4 个维度后再继续。" },
  { id: "ev.04", missionId: MSN01_ID, t: "09:33:14", tMs: 0, kind: "browser", actor: "agent.research", target: "ctx.browser.notion", text: "Opened browser session → <b>notion.so/pricing</b>。", runtime: { tab: "notion · tab #4", transport: "direct-CDP", session: "sess_8f2e", bytes: "1.2 MB" } },
  { id: "ev.05", missionId: MSN01_ID, t: "09:33:22", tMs: 0, kind: "browser", actor: "agent.research", target: "ctx.browser.notion", text: "Snapshot captured · DOM 312 nodes · pricing-table 模块已锁定。", evidence: [{ kind: "snapshot", id: "snap_a31", label: "snap_a31.json" }, { kind: "screenshot", id: "shot_a31", label: "pricing@2x.png" }], tags: ["snapshot"] },
  { id: "ev.06", missionId: MSN01_ID, t: "09:35:09", tMs: 0, kind: "thought", actor: "agent.research", text: "团队套餐价隐藏在表单后 · 标记为「待核对」继续推进 Reflect。" },
  { id: "ev.07", missionId: MSN01_ID, t: "09:42:18", tMs: 0, kind: "browser", actor: "agent.research", target: "ctx.browser.reflect", text: "Navigated → <b>reflect.app/pricing</b>。", runtime: { tab: "reflect · tab #6", transport: "direct-CDP", session: "sess_2a91", bytes: "640 kB" } },
  { id: "ev.08", missionId: MSN01_ID, t: "09:48:55", tMs: 0, kind: "browser", actor: "agent.research", target: "ctx.browser.mem", text: "Navigated → <b>get.mem.ai/pricing</b>。", runtime: { tab: "mem · tab #7", transport: "direct-CDP", session: "sess_5d1c", bytes: "812 kB" } },
  { id: "ev.09", missionId: MSN01_ID, t: "09:51:30", tMs: 0, kind: "doc", actor: "agent.doc", target: "ctx.doc.draft", text: "Opened watcher → <code>competitor-matrix.md</code>。已建立基线 snapshot <code>doc_b3</code>。" },
  { id: "ev.10", missionId: MSN01_ID, t: "09:55:42", tMs: 0, kind: "recovery", actor: "agent.browser", target: "ctx.browser.reflect", text: "Browser session <b>detached</b> · WS 1006 · pong timeout。Recovery Agent 已挂起 WI-3。", emph: "danger", tags: ["recovery"], runtime: { bucket: "browser.session.detached", peer: "tk-relay-sea1", attempt: "1/3" } },
  { id: "ev.11", missionId: MSN01_ID, t: "09:56:01", tMs: 0, kind: "thought", actor: "agent.recovery", text: "最近一次操作 <code>browser.snapshot</code> 可能已执行——不自动重试。提示用户决定。" },
  { id: "ev.12", missionId: MSN01_ID, t: "10:02:19", tMs: 0, kind: "doc", actor: "agent.doc", target: "ctx.doc.draft", text: "Drafted §1 §2 §3 · 写入 480 行 · diff 已保存。", emph: "success", evidence: [{ kind: "diff", id: "diff_c1", label: "draft @ rev 7" }], runtime: { writer: "agent.doc", bytes: "+12.8 kB" } },
  { id: "ev.13", missionId: MSN01_ID, t: "10:03:44", tMs: 0, kind: "tool", actor: "agent.research", target: "ctx.api.serper", text: 'Search · <code>"Mem AI" pricing teams 2026</code> · 12 results。' },
  { id: "ev.14", missionId: MSN01_ID, t: "10:05:01", tMs: 0, kind: "browser", actor: "agent.research", target: "ctx.browser.notion", text: "Extracted 6 pricing claims · 团队价仍待表单提交。", evidence: [{ kind: "extract", id: "ex_n1", label: "notion_pricing.json" }] },
  { id: "ev.15", missionId: MSN01_ID, t: "10:08:10", tMs: 0, kind: "thought", actor: "agent.research", text: "为得到团队套餐准确价，需要提交团队规模 5 人——这一步是非幂等，需用户审批。" },
  { id: "ev.16", missionId: MSN01_ID, t: "10:11:33", tMs: 0, kind: "approval", actor: "agent.browser", target: "ctx.browser.notion", text: "Requested approval · <b>browser.form.submit</b> · notion.so/pricing。", emph: "warn", tags: ["needs_approval"], approvalId: "ap.notion-form" },
  { id: "ev.17", missionId: MSN01_ID, t: "10:11:48", tMs: 0, kind: "tool", actor: "agent.coord", text: "Mission state → <b>needs_approval</b> · 暂停 WI-5。其余 work items 继续。" },
  { id: "ev.18", missionId: MSN01_ID, t: "10:12:04", tMs: 0, kind: "approval", actor: "agent.doc", target: "ctx.doc.draft", text: "Requested approval · <b>doc.write</b> · 追加 §4 协作能力（480 字）。", emph: "warn", tags: ["needs_approval"], approvalId: "ap.doc-write-section4" },
  { id: "ev.19", missionId: MSN01_ID, t: "10:12:32", tMs: 0, kind: "browser", actor: "agent.research", target: "ctx.browser.mem", text: "Snapshot captured · 抓取 pricing FAQ。", evidence: [{ kind: "snapshot", id: "snap_m9", label: "snap_m9.json" }] },
  { id: "ev.20", missionId: MSN01_ID, t: "10:13:19", tMs: 0, kind: "thought", actor: "agent.review", text: "提前扫一遍 §1-§3：发现 1 处引用缺失（Reflect Backlinks AI 段无 citation）。" },
  { id: "ev.21", missionId: MSN01_ID, t: "10:13:55", tMs: 0, kind: "artifact", actor: "agent.research", text: "Artifact registered · <code>evidence/notion_pricing.json</code> · 11 KB · sha 4c1d。", evidence: [{ kind: "json", id: "art_1", label: "notion_pricing.json" }] },
  { id: "ev.22", missionId: MSN01_ID, t: "10:14:02", tMs: 0, kind: "tool", actor: "agent.coord", text: "Awaiting your decision · 2 pending approvals · WI-3 blocked。" },
];

/**
 * Returns the demo dataset with every `*MS` timestamp set to a sensible
 * offset from `now`. The wall-clock t / createdAt display strings stay
 * as the design's fixed values (the design is set "今天" with "09:31"
 * etc) so the timeline reads the same regardless of bootstrap time.
 */
export function buildDemoFixtures(now: number): {
  missions: Mission[];
  workItems: WorkItem[];
  approvals: ApprovalRequest[];
  timeline: ActivityEvent[];
  agents: Agent[];
  contextSources: ContextSource[];
} {
  // Map each event to a real monotonic tMs anchored at `now`. The first
  // event opens "43 minutes ago" — matching the design's "09:31 ... 10:14"
  // span (about 43 minutes). Subsequent events step forward
  // proportionally.
  const TOTAL_SPAN_MS = 43 * 60 * 1000;
  const t0 = now - TOTAL_SPAN_MS;
  const stretchTimeline = DEMO_TIMELINE.map((event, i) => ({
    ...event,
    tMs: t0 + Math.round((i / Math.max(1, DEMO_TIMELINE.length - 1)) * TOTAL_SPAN_MS),
  }));

  const missions = DEMO_MISSIONS.map((m) => ({ ...m, createdAtMs: t0 }));
  const approvals = DEMO_APPROVALS.map((a) => ({
    ...a,
    requestedAtMs: now - 60 * 1000, // ~1 minute ago
  }));

  return {
    missions,
    workItems: DEMO_WORK_ITEMS,
    approvals,
    timeline: stretchTimeline,
    agents: DEMO_AGENTS,
    contextSources: DEMO_CONTEXT_SOURCES,
  };
}
