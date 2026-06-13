// Context Sources index — all sources grouped by kind (browser, doc,
// folder, api, desktop). Uses /mission-context-sources for read + attach.

import { useState, type FormEvent } from "react";

import type { ContextKind, ContextSource } from "../api/mission-api";
import { useContextSources, useCreateContextSource } from "../api/useMissionData";
import { formatRelativeAgo } from "../util/format-time";
import { CtxIcon, Icon } from "../components/Icon";
import { useAppState } from "../state/AppState";
import { canUseOperatorActions, OPERATOR_ACTION_SCOPE_HINT } from "../state/scopeAccess";

interface Section {
  kind: ContextKind;
  title: string;
  desc: string;
}

const SECTIONS: Section[] = [
  { kind: "browser", title: "Browser evidence", desc: "Pages, screenshots, and browser context used while doing work." },
  { kind: "doc", title: "Documents", desc: "本地或工作区文档 · 由 doc watcher 跟踪 diff，写入需审批。" },
  { kind: "folder", title: "Files & folders", desc: "只读视图 · 用作证据归档与导出基础。" },
  { kind: "api", title: "API clients", desc: "外部 API 调用 · 配额、最近调用与作用域。" },
  { kind: "desktop", title: "Desktop windows", desc: "macOS / Windows 应用上下文 · 默认 opt-in 且审批门控。" },
];

export function ContextSourcesPage() {
  const { state } = useAppState();
  const canAttachSource = canUseOperatorActions(state.scope);
  const sourcesRemote = useContextSources([]);
  const createContextSource = useCreateContextSource();
  const [attachOpen, setAttachOpen] = useState(false);
  const [kind, setKind] = useState<ContextKind>("doc");
  const [title, setTitle] = useState("");
  const [urlOrPath, setUrlOrPath] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sources = sourcesRemote.value;
  const grouped: Partial<Record<ContextKind, ContextSource[]>> = {};
  for (const c of sources) {
    (grouped[c.kind] ||= []).push(c);
  }

  const onAttach = async (event: FormEvent) => {
    event.preventDefault();
    if (!canAttachSource || submitting) return;
    const trimmedTitle = title.trim();
    const trimmedUrl = urlOrPath.trim();
    if (!trimmedTitle || !trimmedUrl) return;
    setSubmitting(true);
    setNotice(null);
    setError(null);
    try {
      await createContextSource({
        kind,
        title: trimmedTitle,
        ...(kind === "api" ? { url: trimmedUrl } : { path: trimmedUrl }),
      });
      setTitle("");
      setUrlOrPath("");
      setAttachOpen(false);
      setNotice("Context source attached.");
      sourcesRemote.refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>Sources</h2>
          <div className="sub">
            Browser · 文档 · 文件夹 · API · 桌面 — 这是 mission 可用的证据和上下文，不是连接配置页。
          </div>
        </div>
        <div className="right">
          <button
            type="button"
            className="btn"
            disabled
            title="Context policy editing is not available in the Control Center yet."
          >
            <Icon name="shield" size={13} /> Policies
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={!canAttachSource}
            title={canAttachSource ? "Attach a document, folder, API, or desktop context source." : OPERATOR_ACTION_SCOPE_HINT}
            onClick={() => {
              setAttachOpen((value) => !value);
              setNotice(null);
              setError(null);
            }}
          >
            <Icon name="plus" size={13} /> Attach source
          </button>
        </div>
      </div>

      {notice && (
        <div className="notice success" role="status">
          {notice}
        </div>
      )}
      {error && (
        <div className="notice danger" role="alert">
          {error}
        </div>
      )}
      {!canAttachSource && (
        <div className="notice" role="note">
          Adding sources requires an operator or admin token.
        </div>
      )}

      {attachOpen && canAttachSource && (
        <form className="card context-attach-card" onSubmit={onAttach}>
          <div className="card-bd">
            <div className="context-attach-grid">
              <label>
                <span>Kind</span>
                <select className="field" value={kind} onChange={(event) => setKind(event.target.value as ContextKind)}>
                  <option value="doc">Document</option>
                  <option value="folder">Folder</option>
                  <option value="api">API</option>
                  <option value="desktop">Desktop</option>
                </select>
              </label>
              <label>
                <span>Title</span>
                <input
                  className="field"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="Launch notes"
                  required
                />
              </label>
              <label>
                <span>{kind === "api" ? "URL" : "Path or identifier"}</span>
                <input
                  className="field"
                  value={urlOrPath}
                  onChange={(event) => setUrlOrPath(event.target.value)}
                  placeholder={kind === "api" ? "https://api.example.com" : "/Users/me/project/notes.md"}
                  required
                />
              </label>
              <button type="submit" className="btn primary" disabled={submitting || !title.trim() || !urlOrPath.trim()}>
                {submitting ? "Attaching…" : "Attach"}
              </button>
            </div>
          </div>
        </form>
      )}

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
      <div className="meta-col">
        last {source.lastUse || (source.lastUseAtMs ? formatRelativeAgo(source.lastUseAtMs) : "—")}
      </div>
      <div>
        <span className={"tag " + stateTone}>
          <span className="dot" />
          {source.state}
        </span>
      </div>
    </div>
  );
}
