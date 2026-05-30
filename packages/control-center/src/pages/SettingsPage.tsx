// Settings — local runtime configuration and policy defaults.

import { useRef, useState } from "react";

import type { BridgeStatus, DiagnosticsSnapshot, ModelCatalogConfigReport, ModelsReport } from "../api/types";
import { useApiClient } from "../api/useApiClient";
import { Icon } from "../components/Icon";
import { usePolling } from "../hooks/usePolling";
import { useAppState } from "../state/AppState";

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
  bridgeStatus: BridgeStatus | null;
  models: ModelsReport | null;
  modelCatalogConfig: ModelCatalogConfigReport | null;
  modelCatalogConfigError: string | null;
  reachable: boolean;
}

export function SettingsPage() {
  const client = useApiClient();
  const { state } = useAppState();
  const editorDirtyRef = useRef(false);
  const [catalogEditor, setCatalogEditor] = useState("");
  const [catalogNotice, setCatalogNotice] = useState<string | null>(null);
  const [catalogSaving, setCatalogSaving] = useState(false);
  const [live, setLive] = useState<SettingsLive>({
    diagnostics: null,
    bridgeStatus: null,
    models: null,
    modelCatalogConfig: null,
    modelCatalogConfigError: null,
    reachable: false,
  });

  usePolling(async () => {
    const [diagnosticsResult, bridgeStatusResult, modelsResult, modelCatalogConfigResult] = await Promise.allSettled([
      client.get<DiagnosticsSnapshot>("/diagnostics"),
      client.get<BridgeStatus>("/bridge/status"),
      client.get<ModelsReport>("/models"),
      client.getNoAuthReset<ModelCatalogConfigReport>("/daemon/config/model-catalog"),
    ]);
    const diagnostics = diagnosticsResult.status === "fulfilled" ? diagnosticsResult.value : null;
    const bridgeStatus = bridgeStatusResult.status === "fulfilled" ? bridgeStatusResult.value : null;
    const models = modelsResult.status === "fulfilled" ? modelsResult.value : null;
    const modelCatalogConfig =
      modelCatalogConfigResult.status === "fulfilled" ? modelCatalogConfigResult.value : null;
    const modelCatalogConfigError =
      modelCatalogConfigResult.status === "rejected" ? readableSettingsError(modelCatalogConfigResult.reason) : null;
    if (modelCatalogConfig && !editorDirtyRef.current) {
      setCatalogEditor(modelCatalogConfig.content);
    }
    setLive({
      diagnostics,
      bridgeStatus,
      models,
      modelCatalogConfig,
      modelCatalogConfigError,
      reachable: diagnostics != null || bridgeStatus != null || models != null || modelCatalogConfig != null,
    });
  }, POLL_MS);

  const saveCatalog = async () => {
    setCatalogSaving(true);
    setCatalogNotice(null);
    try {
      const saved = await client.putNoAuthReset<ModelCatalogConfigReport>("/daemon/config/model-catalog", {
        content: catalogEditor,
      });
      setLive((current) => ({
        ...current,
        modelCatalogConfig: saved,
        modelCatalogConfigError: null,
        reachable: true,
      }));
      editorDirtyRef.current = false;
      setCatalogEditor(saved.content);
      setCatalogNotice(
        saved.restartRequired
          ? "Catalog saved. Restart the daemon for the new runtime model selection to take effect."
          : "Catalog saved and reloaded."
      );
    } catch (error) {
      setCatalogNotice(readableSettingsError(error));
    } finally {
      setCatalogSaving(false);
    }
  };

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
          <ModelCatalogEditor
            config={live.modelCatalogConfig}
            error={live.modelCatalogConfigError}
            editor={catalogEditor}
            saving={catalogSaving}
            notice={catalogNotice}
            scope={state.scope}
            onChange={(value) => {
              editorDirtyRef.current = true;
              setCatalogNotice(null);
              setCatalogEditor(value);
            }}
            onSave={saveCatalog}
          />
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

      <BrowserBridgeSettings
        diagnostics={live.diagnostics}
        bridgeStatus={live.bridgeStatus}
        reachable={live.reachable}
      />

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

function BrowserBridgeSettings({
  diagnostics,
  bridgeStatus,
  reachable,
}: {
  diagnostics: DiagnosticsSnapshot | null;
  bridgeStatus: BridgeStatus | null;
  reachable: boolean;
}) {
  const checks = (diagnostics?.readiness?.checks ?? []).filter((check) =>
    check.id === "browser_transport" || check.id === "browser_runtime"
  );
  const health = bridgeStatus?.transport.health;
  const healthText = health
    ? health.healthy
      ? "healthy"
      : health.reason ?? "unhealthy"
    : reachable
      ? "not reported"
      : "offline";
  const expertText = bridgeStatus
    ? bridgeStatus.expertLane.available
      ? "available"
      : bridgeStatus.expertLane.reason ?? "unavailable"
    : "checking";
  const transportTone = !bridgeStatus || bridgeStatus.ok ? (health?.healthy === false ? "warning" : "success") : "danger";
  const expertTone = bridgeStatus?.expertLane.available ? "success" : "warning";
  const endpoint = bridgeStatus?.directCdp.endpoint ?? "";

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-hd">
        <Icon name="browser" size={13} />
        <h3>Browser bridge</h3>
        <span className={"tag " + transportTone} style={{ marginLeft: "auto" }}>
          {healthText}
        </span>
      </div>
      <div className="card-bd">
        <div className="setting-row" style={{ paddingTop: 4 }}>
          <div className="lbl"><b>Transport</b><span>browser work execution route</span></div>
          <div>
            <input
              className="field"
              value={bridgeStatus ? `${bridgeStatus.transport.mode} · ${bridgeStatus.transport.label}` : "checking"}
              readOnly
            />
          </div>
          <div><span className={"tag " + transportTone}>{bridgeStatus?.transport.mode ?? "pending"}</span></div>
        </div>
        <div className="setting-row">
          <div className="lbl"><b>Expert lane</b><span>direct browser diagnostics and fallback controls</span></div>
          <div><input className="field" value={expertText} readOnly /></div>
          <div><span className={"tag " + expertTone}>{bridgeStatus?.expertLane.available ? "ready" : "attention"}</span></div>
        </div>
        <div className="setting-row">
          <div className="lbl"><b>Direct CDP endpoint</b><span>required only for direct-CDP expert lane</span></div>
          <div><input className="field mono" value={endpoint || "(not configured)"} readOnly /></div>
          <div><span className={"tag " + (endpoint ? "success" : "warning")}>{endpoint ? "set" : "optional"}</span></div>
        </div>
        <div className="setting-row">
          <div className="lbl"><b>Operator checks</b><span>transport and runtime issues from diagnostics</span></div>
          <div className="settings-health-list">
            {checks.length > 0 ? checks.map((check) => (
              <div key={check.id} className="settings-health-line" data-status={check.status}>
                <span className={`status-dot ${readinessDotClass(check.status)}`} />
                <div>
                  <b>{check.label}</b>
                  <span>{check.detail}</span>
                  {check.action ? <em>{check.action}</em> : null}
                </div>
              </div>
            )) : (
              <div className="muted" style={{ fontSize: 12 }}>
                {reachable ? "Waiting for browser readiness checks." : "Connect to the daemon to inspect browser readiness."}
              </div>
            )}
          </div>
          <div><span className="tag info">{checks.length || 0} check(s)</span></div>
        </div>
        <div className="setting-row" style={{ borderBottom: 0 }}>
          <div className="lbl"><b>Validation commands</b><span>run before trusting browser-backed missions</span></div>
          <div className="settings-command-list">
            <code>turnkeyai bridge status</code>
            <code>turnkeyai bridge install-extension</code>
            <code>npm run cdp:smoke -- --timeout-ms 45000</code>
          </div>
          <div><span className="tag info">local</span></div>
        </div>
      </div>
    </div>
  );
}

function ModelCatalogEditor({
  config,
  error,
  editor,
  saving,
  notice,
  scope,
  onChange,
  onSave,
}: {
  config: ModelCatalogConfigReport | null;
  error: string | null;
  editor: string;
  saving: boolean;
  notice: string | null;
  scope: string;
  onChange: (value: string) => void;
  onSave: () => void;
}) {
  const canAttemptSave = scope === "admin" || scope === "unknown";
  const validation = config?.validation;
  return (
    <div className="setting-row settings-catalog-editor">
      <div className="lbl">
        <b>Catalog editor</b>
        <span>admin-scoped local JSON; restart only when live reload is unavailable</span>
      </div>
      <div className="settings-catalog-editor-main">
        <textarea
          className="field settings-catalog-textarea"
          value={editor}
          spellCheck={false}
          disabled={!canAttemptSave}
          onChange={(event) => onChange(event.target.value)}
          aria-label="Model catalog JSON"
        />
        <div className="settings-catalog-meta">
          {config ? (
            <>
              <span>{config.editableModelCatalogPath}</span>
              <span>{config.liveReloadAvailable ? "live reload available" : "daemon restart may be required"}</span>
              <span>{validation?.modelCount ?? 0} model(s), {validation?.chainCount ?? 0} chain(s)</span>
            </>
          ) : (
            <span>{error ?? "Admin scope is required to read or edit the model catalog."}</span>
          )}
        </div>
        {validation && (!validation.ok || validation.warnings.length > 0) ? (
          <div className="settings-catalog-feedback" data-ok={validation.ok ? "true" : "false"}>
            {[...validation.errors, ...validation.warnings].slice(0, 4).map((item) => (
              <div key={item}>{item}</div>
            ))}
          </div>
        ) : null}
        {notice ? <div className="settings-catalog-feedback" data-ok="true">{notice}</div> : null}
      </div>
      <div>
        <button
          type="button"
          className="btn primary"
          onClick={onSave}
          disabled={!canAttemptSave || saving || editor.trim().length === 0}
          title={canAttemptSave ? "Validate and save the local model catalog" : "Admin token required"}
        >
          {saving ? "Saving" : "Save"}
        </button>
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

function readinessDotClass(status: "ok" | "warn" | "error"): string {
  if (status === "error") return "blocked";
  if (status === "warn") return "needs_approval";
  return "done";
}

function readableSettingsError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (typeof error === "string" && error.trim()) return error.trim();
  return "request failed";
}
