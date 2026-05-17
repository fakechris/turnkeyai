// Settings — identity, LLM providers, policies, local data paths.
// Read-only in K1. K3 adds real writes through the new
// /daemon/config/* endpoints from PR J0's spec §6.

import { Icon } from "../components/Icon";

const PROVIDERS = [
  { k: "Anthropic", note: "claude-sonnet-4.5 · claude-haiku-4.5 · operator", state: "configured" },
  { k: "OpenAI", note: "gpt-5.1-pro · operator scope", state: "configured" },
  { k: "Moonshot", note: "kimi-k2-128k", state: "configured" },
  { k: "Local (Ollama)", note: "llama4.1:70b · qwen3:32b", state: "ready" },
];

const POLICIES = [
  { k: "browser.form.submit", v: "always require approval", lvl: "warning" as const },
  { k: "browser.download", v: "require approval if size > 1 MB", lvl: "warning" as const },
  { k: "doc.write in ~/turnkey/**", v: "require approval", lvl: "warning" as const },
  { k: "desktop.*", v: "require approval · log every call", lvl: "danger" as const },
  { k: "search.web", v: "auto-allow", lvl: "success" as const },
];

export function SettingsPage() {
  return (
    <div className="page" style={{ maxWidth: 920 }}>
      <div className="page-head">
        <div>
          <h2>Settings</h2>
          <div className="sub">本地数据路径、模型、策略、传输——单机配置，不离开本机。</div>
        </div>
      </div>

      <div className="card">
        <div className="card-hd"><h3>Identity</h3></div>
        <div className="card-bd">
          <div className="setting-row" style={{ paddingTop: 4 }}>
            <div className="lbl"><b>Operator name</b><span>显示在审批 / timeline 中</span></div>
            <div><input className="field" defaultValue="operator" /></div>
            <div />
          </div>
          <div className="setting-row" style={{ borderBottom: 0 }}>
            <div className="lbl"><b>Default approval window</b><span>到期后 mission 自动暂停</span></div>
            <div>
              <select className="field" defaultValue="15m">
                <option>5m</option>
                <option>15m</option>
                <option>1h</option>
                <option>never</option>
              </select>
            </div>
            <div />
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-hd">
          <h3>LLM providers</h3>
          <span className="mono faint" style={{ fontSize: 10, marginLeft: "auto" }}>K3 wires real writes</span>
        </div>
        <div className="card-bd">
          {PROVIDERS.map((p) => (
            <div key={p.k} className="setting-row">
              <div className="lbl"><b>{p.k}</b><span>{p.note}</span></div>
              <div>
                <input
                  className="field"
                  defaultValue={"sk-•••••••••••••• · " + p.k.toLowerCase()}
                  type="password"
                />
              </div>
              <div><span className="tag success">{p.state}</span></div>
            </div>
          ))}
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-hd">
          <Icon name="shield" size={13} />
          <h3>Policies</h3>
        </div>
        <div className="card-bd">
          {POLICIES.map((p) => (
            <div key={p.k} className="setting-row" style={{ paddingTop: 8, paddingBottom: 8 }}>
              <div className="lbl">
                <b className="mono" style={{ fontSize: 12, fontWeight: 500 }}>{p.k}</b>
              </div>
              <div className="muted">{p.v}</div>
              <div><span className={"tag " + p.lvl}>policy</span></div>
            </div>
          ))}
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-hd"><h3>Local data</h3></div>
        <div className="card-bd">
          <div className="setting-row" style={{ paddingTop: 4 }}>
            <div className="lbl"><b>Mission store</b><span>SQLite · WAL (K2)</span></div>
            <div>
              <input
                className="field"
                defaultValue="~/Library/Application Support/TurnkeyAI/missions.db"
              />
            </div>
            <div className="mono faint" style={{ alignSelf: "center" }}>—</div>
          </div>
          <div className="setting-row">
            <div className="lbl"><b>Artifact store</b><span>对象 + sha 索引</span></div>
            <div>
              <input
                className="field"
                defaultValue="~/Library/Application Support/TurnkeyAI/artifacts/"
              />
            </div>
            <div className="mono faint" style={{ alignSelf: "center" }}>—</div>
          </div>
          <div className="setting-row" style={{ borderBottom: 0 }}>
            <div className="lbl"><b>Logs & replay</b><span>保留天数</span></div>
            <div>
              <select className="field" defaultValue="30">
                <option>7</option>
                <option>14</option>
                <option>30</option>
                <option>90</option>
              </select>
            </div>
            <div />
          </div>
        </div>
      </div>
    </div>
  );
}
