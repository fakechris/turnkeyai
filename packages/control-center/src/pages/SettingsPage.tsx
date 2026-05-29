// Settings — read-only runtime configuration and policy defaults.

import { useState } from "react";

import type { DiagnosticsSnapshot, ModelsReport } from "../api/types";
import { useApiClient } from "../api/useApiClient";
import { Icon } from "../components/Icon";
import { usePolling } from "../hooks/usePolling";

const POLICIES = [
  { k: "browser.form.submit", v: "always require approval", lvl: "warning" as const },
  { k: "browser.download", v: "require approval if size > 1 MB", lvl: "warning" as const },
  { k: "doc.write in ~/turnkey/**", v: "require approval", lvl: "warning" as const },
  { k: "desktop.*", v: "require approval · log every call", lvl: "danger" as const },
  { k: "search.web", v: "auto-allow", lvl: "success" as const },
];

const POLL_MS = 5_000;

interface SettingsLive {
  diagnostics: DiagnosticsSnapshot | null;
  models: ModelsReport | null;
  reachable: boolean;
}

export function SettingsPage() {
  const client = useApiClient();
  const [live, setLive] = useState<SettingsLive>({
    diagnostics: null,
    models: null,
    reachable: false,
  });

  usePolling(async () => {
    const [diagnosticsResult, modelsResult] = await Promise.allSettled([
      client.get<DiagnosticsSnapshot>("/diagnostics"),
      client.get<ModelsReport>("/models"),
    ]);
    const diagnostics = diagnosticsResult.status === "fulfilled" ? diagnosticsResult.value : null;
    const models = modelsResult.status === "fulfilled" ? modelsResult.value : null;
    setLive({ diagnostics, models, reachable: diagnostics != null || models != null });
  }, POLL_MS);

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
            <div><input className="field" value="operator" readOnly /></div>
            <div><span className="tag info">local</span></div>
          </div>
          <div className="setting-row" style={{ borderBottom: 0 }}>
            <div className="lbl"><b>Daemon auth</b><span>Control Center 使用本地 token 访问 daemon</span></div>
            <div><input className="field" value={live.diagnostics?.daemon.authMode ?? "checking"} readOnly /></div>
            <div><span className={"tag " + authTone(live.diagnostics?.daemon.authMode)}>{live.diagnostics?.daemon.authMode ?? "pending"}</span></div>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-hd">
          <h3>LLM models</h3>
          <span className="mono faint" style={{ fontSize: 10, marginLeft: "auto" }}>
            {live.models?.adapterMode ?? (live.reachable ? "checking" : "offline")}
          </span>
        </div>
        <div className="card-bd">
          <ModelCatalogRow models={live.models} />
          <DefaultModelSelectionRow models={live.models} />
          <ModelChainsBlock models={live.models} />
          {live.models?.models.length ? (
            live.models.models.map((model) => (
              <div key={model.id} className="setting-row">
                <div className="lbl">
                  <b>{model.label || model.id}</b>
                  <span>{model.providerId} · {model.protocol} · {model.model}</span>
                </div>
                <div>
                  <input className="field" value={model.apiKeyEnv} readOnly />
                </div>
                <div>
                  <span className={"tag " + (model.configured ? "success" : "warning")}>
                    {model.configured ? "configured" : "missing key"}
                  </span>
                </div>
              </div>
            ))
          ) : (
            <div className="setting-row" style={{ borderBottom: 0 }}>
              <div className="lbl"><b>No live models</b><span>模型 catalog 未配置或 daemon 未连接</span></div>
              <div className="muted">Configure a model catalog before production task runs.</div>
              <div><span className="tag warning">attention</span></div>
            </div>
          )}
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
          <PathRow label="Runtime root" value={live.diagnostics?.paths.runtimeRoot} />
          <PathRow label="Data directory" value={live.diagnostics?.paths.dataDir} />
          <PathRow label="Config file" value={live.diagnostics?.paths.configFile} />
          <PathRow label="Daemon log" value={live.diagnostics?.paths.logFile} />
          <PathRow label="Model catalog" value={live.diagnostics?.paths.modelCatalogPath ?? live.models?.modelCatalogPath ?? null} last />
        </div>
      </div>
    </div>
  );
}

function ModelCatalogRow({ models }: { models: ModelsReport | null }) {
  const path = models?.modelCatalogPath ?? null;
  return (
    <div className="setting-row" style={{ paddingTop: 4 }}>
      <div className="lbl"><b>Catalog</b><span>daemon 解析后的模型 catalog</span></div>
      <div><input className="field" value={path ?? "(none)"} readOnly /></div>
      <div><span className={"tag " + (path ? "success" : "warning")}>{path ? "loaded" : "missing"}</span></div>
    </div>
  );
}

function DefaultModelSelectionRow({ models }: { models: ModelsReport | null }) {
  const selection = models?.defaultSelection;
  const primary = selection?.ok ? selection.primaryModelId : null;
  const fallbacks = selection?.ok ? selection.fallbackModelIds ?? [] : [];
  const detail = selection?.ok
    ? [
        selection.chainId ? `chain ${selection.chainId}` : "direct model",
        primary ? `primary ${primary}` : null,
        fallbacks.length ? `fallbacks ${fallbacks.join(", ")}` : "no fallbacks",
      ].filter(Boolean).join(" · ")
    : selection?.error ?? "waiting for model selection";
  return (
    <div className="setting-row">
      <div className="lbl"><b>Default selection</b><span>what production tasks use when no model is specified</span></div>
      <div><input className="field" value={detail} readOnly /></div>
      <div>
        <span className={"tag " + (selection?.ok ? "success" : "warning")}>
          {selection?.ok ? "ready" : "attention"}
        </span>
      </div>
    </div>
  );
}

function ModelChainsBlock({ models }: { models: ModelsReport | null }) {
  const chains = models?.modelChains ?? [];
  if (chains.length === 0) return null;
  return (
    <div className="setting-row">
      <div className="lbl"><b>Model chains</b><span>primary and fallback routing</span></div>
      <div className="settings-chain-list">
        {chains.map((chain) => (
          <div key={chain.id} className="settings-chain-line">
            <b>{chain.id}</b>
            <span>{chain.primary}{chain.fallbacks.length ? ` -> ${chain.fallbacks.join(" -> ")}` : ""}</span>
          </div>
        ))}
      </div>
      <div><span className="tag info">{chains.length} chain(s)</span></div>
    </div>
  );
}

function PathRow({ label, value, last }: { label: string; value?: string | null; last?: boolean }) {
  return (
    <div className="setting-row" style={{ borderBottom: last ? 0 : undefined }}>
      <div className="lbl"><b>{label}</b><span>resolved by daemon</span></div>
      <div><input className="field mono" value={value ?? "checking"} readOnly /></div>
      <div className="mono faint" style={{ alignSelf: "center" }}>—</div>
    </div>
  );
}

function authTone(authMode: DiagnosticsSnapshot["daemon"]["authMode"] | undefined): string {
  if (!authMode) return "warning";
  return authMode === "disabled" ? "warning" : "success";
}
