// Settings — user-facing preferences first, local operator details collapsed.

import { useRef, useState } from "react";

import type { DiagnosticsSnapshot, ModelCatalogConfigReport, ModelsReport } from "../api/types";
import { useApiClient } from "../api/useApiClient";
import { Icon } from "../components/Icon";
import { usePolling } from "../hooks/usePolling";
import { useAppState } from "../state/AppState";

const POLICIES = [
  { k: "Submitting forms in the browser", v: "Ask first", lvl: "warning" as const },
  { k: "Large downloads", v: "Ask first", lvl: "warning" as const },
  { k: "Writing files", v: "Ask first", lvl: "warning" as const },
  { k: "Desktop actions", v: "Ask first and keep a log", lvl: "danger" as const },
  { k: "Web search", v: "Allowed", lvl: "success" as const },
];

const POLL_MS = 5_000;

interface SettingsLive {
  diagnostics: DiagnosticsSnapshot | null;
  models: ModelsReport | null;
  modelCatalogConfig: ModelCatalogConfigReport | null;
  modelCatalogConfigError: string | null;
  reachable: boolean;
}

export function SettingsPage() {
  const client = useApiClient();
  const { state, setRoute } = useAppState();
  const editorDirtyRef = useRef(false);
  const [catalogEditor, setCatalogEditor] = useState("");
  const [catalogNotice, setCatalogNotice] = useState<string | null>(null);
  const [catalogSaving, setCatalogSaving] = useState(false);
  const [live, setLive] = useState<SettingsLive>({
    diagnostics: null,
    models: null,
    modelCatalogConfig: null,
    modelCatalogConfigError: null,
    reachable: false,
  });

  usePolling(async () => {
    const [diagnosticsResult, modelsResult, modelCatalogConfigResult] = await Promise.allSettled([
      client.get<DiagnosticsSnapshot>("/diagnostics"),
      client.get<ModelsReport>("/models"),
      client.getNoAuthReset<ModelCatalogConfigReport>("/daemon/config/model-catalog"),
    ]);
    const diagnostics = diagnosticsResult.status === "fulfilled" ? diagnosticsResult.value : null;
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
      models,
      modelCatalogConfig,
      modelCatalogConfigError,
      reachable: diagnostics != null || models != null || modelCatalogConfig != null,
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

  const defaultModel = live.models?.defaultSelection?.ok ? live.models.defaultSelection.primaryModelId : null;
  const modelReady = Boolean(defaultModel && live.models?.models.find((model) => model.id === defaultModel)?.configured);

  return (
    <div className="page settings-page">
      <div className="human-page-head">
        <div>
          <h2>Settings</h2>
          <p>Keep the defaults unless something is not working.</p>
        </div>
      </div>

      <div className="settings-overview-grid">
        <section className="settings-overview-card">
          <Icon name="settings" size={18} />
          <h3>Model</h3>
          <p>What TurnkeyAI uses to think and answer.</p>
          <b>{defaultModel ?? "Checking model"}</b>
          <span className={"tag " + (modelReady ? "success" : "warning")}>{modelReady ? "ready" : "needs key"}</span>
        </section>
        <section className="settings-overview-card">
          <Icon name="agents" size={18} />
          <h3>Team</h3>
          <p>How helpers are chosen for new chats.</p>
          <b>Auto</b>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setRoute("agents");
              window.location.hash = "#/agents";
            }}
          >
            Choose team
          </button>
        </section>
        <section className="settings-overview-card">
          <Icon name="browser" size={18} />
          <h3>Browser</h3>
          <p>Lets TurnkeyAI inspect pages when a chat needs it.</p>
          <b>{live.diagnostics ? "Available" : "Checking"}</b>
          <span className="tag info">optional</span>
        </section>
        <section className="settings-overview-card">
          <Icon name="connect" size={18} />
          <h3>Other apps</h3>
          <p>Lets another AI app send work into TurnkeyAI.</p>
          <b>Local only</b>
          <span className="tag">advanced</span>
        </section>
      </div>

      <details className="settings-advanced">
        <summary>Advanced local setup</summary>
        <div className="settings-advanced-body">
          <div className="card">
            <div className="card-hd"><h3>Access</h3></div>
            <div className="card-bd">
              <div className="setting-row" style={{ paddingTop: 4 }}>
                <div className="lbl"><b>User</b><span>Shown when you approve or deny an action</span></div>
                <div><input className="field" value="operator" readOnly /></div>
                <div><span className="tag info">local</span></div>
              </div>
              <div className="setting-row" style={{ borderBottom: 0 }}>
                <div className="lbl"><b>Local access</b><span>How this browser talks to TurnkeyAI on this machine</span></div>
                <div><input className="field" value={live.diagnostics?.daemon.authMode ?? "checking"} readOnly /></div>
                <div><span className={"tag " + authTone(live.diagnostics?.daemon.authMode)}>{live.diagnostics?.daemon.authMode ?? "pending"}</span></div>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-hd">
              <h3>Model catalog</h3>
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
            </div>
          </div>

          <div className="card">
            <div className="card-hd">
              <Icon name="shield" size={13} />
              <h3>Permissions</h3>
            </div>
            <div className="card-bd">
              {POLICIES.map((p) => (
                <div key={p.k} className="setting-row" style={{ paddingTop: 8, paddingBottom: 8 }}>
                  <div className="lbl">
                    <b style={{ fontSize: 12, fontWeight: 600 }}>{p.k}</b>
                  </div>
                  <div className="muted">{p.v}</div>
                  <div><span className={"tag " + p.lvl}>policy</span></div>
                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <div className="card-hd"><h3>Local files</h3></div>
            <div className="card-bd">
              <PathRow label="Runtime root" value={live.diagnostics?.paths.runtimeRoot} />
              <PathRow label="Data directory" value={live.diagnostics?.paths.dataDir} />
              <PathRow label="Config file" value={live.diagnostics?.paths.configFile} />
              <PathRow label="Daemon log" value={live.diagnostics?.paths.logFile} />
              <PathRow label="Model catalog" value={live.diagnostics?.paths.modelCatalogPath ?? live.models?.modelCatalogPath ?? null} last />
            </div>
          </div>
        </div>
      </details>
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

function readableSettingsError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (typeof error === "string" && error.trim()) return error.trim();
  return "request failed";
}
