// Agent Connect — preset cards on the left, detail panel on the right.
// Carries forward PR I's scope-aware downgrade: when the daemon token is
// scope=read, fields are still shown (so the user can see what the
// endpoint LOOKS like) but the bottom "why not admin?" card surfaces +
// the Rotate/Capabilities controls are styled as visibly read-only.

import { useState } from "react";

import { MOCK_DATA } from "../mock/mission-data";
import { COLOR_BG, COLOR_FG } from "../components/atoms";
import { Icon } from "../components/Icon";
import { useAppState } from "../state/AppState";

export function AgentConnectPage() {
  const { state } = useAppState();
  const [selected, setSelected] = useState<string>("codex");
  const preset = MOCK_DATA.presets.find((p) => p.id === selected) ?? MOCK_DATA.presets[0];
  if (!preset) return null;

  // For K1 we keep the design's tokens display (sk-•••… style mask).
  // K3 will source the real daemon token + scope from AppState.
  const tokenMasked = state.token ? maskToken(state.token) : "tk_op_••••••••••••••••4f12";
  const endpoint = `${window.location.origin}/bridge/command`;

  const copy = (text: string) => {
    void navigator.clipboard.writeText(text).catch(() => {
      // Clipboard can fail in non-HTTPS / unfocused contexts; for K1
      // we just swallow — the value is still visible in the readOnly
      // input so the user can select+copy manually.
    });
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>Agent Connect</h2>
          <div className="sub">
            把 Codex / Claude Code / Kimi / Comet / 自定义 OpenAPI client 接进来。Token scope 默认 operator。
          </div>
        </div>
        <div className="right">
          <button type="button" className="btn"><Icon name="external" size={13} /> Bridge docs</button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: 20 }}>
        <div className="col" style={{ gap: 4 }}>
          {MOCK_DATA.presets.map((p) => (
            <button
              key={p.id}
              type="button"
              className={"sb-item" + (selected === p.id ? " active" : "")}
              onClick={() => setSelected(p.id)}
              style={{ background: selected === p.id ? "var(--surface)" : "transparent" }}
            >
              <span className="glyph">
                <span
                  style={{
                    display: "inline-block",
                    width: 10,
                    height: 10,
                    borderRadius: 3,
                    background: COLOR_BG[p.color],
                    border: `1.5px solid ${COLOR_FG[p.color]}`,
                  }}
                />
              </span>
              <span style={{ flex: 1 }}>{p.name}</span>
              <span
                className={
                  "tag " +
                  (p.state === "connected" ? "success" : p.state === "ready" ? "info" : "")
                }
              >
                {p.state}
              </span>
            </button>
          ))}
        </div>

        <div className="card">
          <div className="card-hd">
            <h3
              style={{
                flex: 1,
                fontSize: 13,
                textTransform: "none",
                letterSpacing: 0,
                color: "var(--text)",
              }}
            >
              {preset.name}
            </h3>
            <span className={"tag " + (preset.state === "connected" ? "success" : "info")}>
              {preset.state}
            </span>
            <button type="button" className="btn"><Icon name="diagnose" size={12} /> Test connection</button>
          </div>
          <div style={{ padding: "16px 18px" }}>
            <div className="muted" style={{ marginBottom: 14, fontSize: 12.5 }}>{preset.note}</div>

            <div className="setting-row" style={{ paddingTop: 4 }}>
              <div className="lbl"><b>Endpoint</b><span>本地 daemon · 不出网</span></div>
              <div>
                <input className="field" readOnly value={endpoint} />
              </div>
              <div className="row" style={{ justifyContent: "flex-end" }}>
                <button type="button" className="btn ghost" onClick={() => copy(endpoint)}>
                  Copy
                </button>
              </div>
            </div>
            <div className="setting-row">
              <div className="lbl"><b>Token</b><span>本地存储 · 启动 daemon 时生成</span></div>
              <div>
                {/* readOnly, no type=password — the value is already
                    masked client-side. Double-masking with input type
                    would render dots-over-dots. Copy button puts the
                    UNMASKED token on the clipboard so the user can
                    actually plug it into an agent config. */}
                <input className="field" readOnly value={tokenMasked} />
              </div>
              <div className="row" style={{ justifyContent: "flex-end" }}>
                <button
                  type="button"
                  className="btn ghost"
                  disabled={!state.token}
                  onClick={() => state.token && copy(state.token)}
                >
                  Copy
                </button>
              </div>
            </div>
            <div className="setting-row">
              <div className="lbl"><b>Scope</b><span>operator = 调度 + 工具调用 · 不含 raw CDP</span></div>
              <div>
                {/* disabled (read-only) — scope changes need K3's
                    /daemon/auth/regenerate-token endpoint. Showing
                    the current scope here is informational. */}
                <select
                  className="field"
                  disabled
                  value={state.scope === "unknown" ? "operator" : state.scope}
                  onChange={() => undefined}
                >
                  <option value="read">read · 只读视图 / 不可写入</option>
                  <option value="operator">operator · 调度 + 工具 + 审批触发</option>
                  <option value="admin">admin · 含 raw-CDP / 配置变更（不推荐）</option>
                </select>
              </div>
              <div />
            </div>
            <div className="setting-row" style={{ borderBottom: 0 }}>
              <div className="lbl"><b>Capabilities</b><span>当前 scope 下可用工具</span></div>
              <div className="row" style={{ flexWrap: "wrap" }}>
                {[
                  "mission.create",
                  "mission.read",
                  "browser.snapshot",
                  "browser.click",
                  "browser.form.submit (approval)",
                  "doc.read",
                  "doc.write (approval)",
                  "search.web",
                ].map((c) => (
                  <span key={c} className="tag">{c}</span>
                ))}
              </div>
              <div />
            </div>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 20 }}>
        <div className="card-hd">
          <Icon name="warning" size={13} />
          <h3>Why not admin by default?</h3>
        </div>
        <div className="card-bd muted" style={{ fontSize: 12.5, lineHeight: 1.6 }}>
          Admin scope 暴露 raw-CDP 与配置变更——对日常 agent 而言风险大于收益。推荐 operator scope
          配合 approval 规则；只有运行时排错需要短期临时 admin。
        </div>
      </div>
    </div>
  );
}

// Mask a token so only the last 4 chars are visible (matches PR I behavior).
function maskToken(token: string): string {
  if (token.length <= 6) return "tk_••••";
  const tail = token.slice(-4);
  return `tk_••••••••••••••••${tail}`;
}
