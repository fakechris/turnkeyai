// Context Sources index — all sources grouped by kind (browser, doc,
// folder, api, desktop). Read-only in K1.

import { MOCK_DATA, type ContextKind, type ContextSource } from "../mock/mission-data";
import { CtxIcon, Icon } from "../components/Icon";

interface Section {
  kind: ContextKind;
  title: string;
  desc: string;
}

const SECTIONS: Section[] = [
  { kind: "browser", title: "Browser sessions", desc: "本地 / relay 浏览器会话。raw-CDP 仍在 Runtime 内可见。" },
  { kind: "doc", title: "Documents", desc: "本地或工作区文档 · 由 doc watcher 跟踪 diff，写入需审批。" },
  { kind: "folder", title: "Files & folders", desc: "只读视图 · 用作证据归档与导出基础。" },
  { kind: "api", title: "API clients", desc: "外部 API 调用 · 配额、最近调用与作用域。" },
  { kind: "desktop", title: "Desktop windows", desc: "macOS / Windows 应用上下文 · 默认 opt-in 且审批门控。" },
];

export function ContextSourcesPage() {
  const grouped: Partial<Record<ContextKind, ContextSource[]>> = {};
  for (const c of MOCK_DATA.contextSources) {
    (grouped[c.kind] ||= []).push(c);
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>Context sources</h2>
          <div className="sub">
            Browser · 文档 · 文件夹 · API · 桌面 — 这是 agent 看得到的一切。
          </div>
        </div>
        <div className="right">
          <button type="button" className="btn"><Icon name="shield" size={13} /> Policies</button>
          <button type="button" className="btn primary"><Icon name="plus" size={13} /> Attach source</button>
        </div>
      </div>

      {SECTIONS.map((s) => (
        <div key={s.kind} className="ctx-section" style={{ marginBottom: 22 }}>
          <h3>
            {s.title} ·{" "}
            <span className="mono faint" style={{ textTransform: "none", letterSpacing: 0 }}>
              {(grouped[s.kind] || []).length}
            </span>
          </h3>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>{s.desc}</div>
          {(grouped[s.kind] || []).map((c) => <ContextRow key={c.id} source={c} />)}
        </div>
      ))}
    </div>
  );
}

function ContextRow({ source }: { source: ContextSource }) {
  const stateTone =
    source.state === "attached" || source.state === "watching" || source.state === "ready"
      ? "success"
      : source.state === "detached"
        ? "danger"
        : "warning";
  return (
    <div className="ctx-row">
      <div className="ico"><CtxIcon kind={source.kind} /></div>
      <div>
        <div className="title">
          {source.title}{" "}
          <span className="faint mono" style={{ fontSize: 10, marginLeft: 6 }}>{source.cn}</span>
        </div>
        <div className="url">{source.url}</div>
      </div>
      <div className="meta-col">{source.transport || source.writer || "—"}</div>
      <div className="meta-col">last {source.lastUse}</div>
      <div>
        <span className={"tag " + stateTone}>
          <span className="dot" />
          {source.state}
        </span>
      </div>
    </div>
  );
}
