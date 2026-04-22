import type { ServerResponse } from "node:http";

export interface BrowserSmokeResponse {
  sessionId?: string;
  targetId?: string;
  dispatchMode?: string;
  resumeMode?: string;
  transportMode?: string;
  transportLabel?: string;
  transportTargetId?: string;
  page?: {
    finalUrl?: string;
    title?: string;
  };
  screenshotPaths?: string[];
  artifactIds?: string[];
  trace?: Array<{
    kind?: string;
    input?: Record<string, unknown>;
    output?: Record<string, unknown>;
  }>;
}

export interface BrowserSmokeTarget {
  targetId?: string;
  url?: string;
  title?: string;
  status?: string;
  active?: boolean;
}

export interface BrowserSmokeHttpClient {
  getJson(url: string): Promise<unknown>;
  postJson(url: string, body: unknown): Promise<unknown>;
}

export const BROWSER_LONG_CHAIN_ACTION_KINDS = [
  "click",
  "type",
  "hover",
  "key",
  "select",
  "drag",
  "waitFor",
  "dialog",
  "probe",
  "storage",
  "cookie",
  "eval",
  "network",
  "download",
  "upload",
  "scroll",
  "console",
  "snapshot",
  "cdp",
] as const;

export function writeExportCsvResponse(res: ServerResponse): void {
  res.statusCode = 200;
  res.setHeader("content-type", "text/csv; charset=utf-8");
  res.setHeader("content-disposition", "attachment; filename=\"export.csv\"");
  res.end("id,name\n1,Ada\n");
}

export function buildRichInteractionFixtureMarkup(): string {
  return [
    '<button id="hover-target" type="button">Hover Target</button>',
    '<select id="plan-select" aria-label="Plan Select">',
    '  <option value="starter">Starter</option>',
    '  <option value="team">Team</option>',
    "</select>",
    '<div id="drag-source" draggable="true" style="width: 80px; padding: 8px; border: 1px solid #888;">Drag Card</div>',
    '<div id="drop-zone" style="width: 140px; min-height: 48px; margin: 8px 0; padding: 8px; border: 1px dashed #888;">Drop Zone</div>',
    '<a id="secondary-link" href="#secondary">Secondary Link</a>',
  ].join("\n    ");
}

export function buildRichInteractionFixtureScript(): string {
  return [
    'const hoverTarget = document.getElementById("hover-target");',
    'hoverTarget.addEventListener("mouseenter", () => {',
    '  document.body.dataset.hovered = "true";',
    "});",
    'const planSelect = document.getElementById("plan-select");',
    'planSelect.addEventListener("change", () => {',
    "  status.textContent = 'selected:' + planSelect.value;",
    "});",
    'const dragSource = document.getElementById("drag-source");',
    'const dropZone = document.getElementById("drop-zone");',
    'dragSource.addEventListener("dragstart", (event) => {',
    '  event.dataTransfer.setData("text/plain", "drag-card");',
    "});",
    'dropZone.addEventListener("dragover", (event) => event.preventDefault());',
    'dropZone.addEventListener("drop", (event) => {',
    "  event.preventDefault();",
    '  dropZone.textContent = event.dataTransfer.getData("text/plain") || "dropped";',
    '  dropZone.dataset.dropped = "true";',
    "});",
  ].join("\n      ");
}

export function buildDownloadUploadFixtureMarkup(): string {
  return [
    '<a id="download-link" href="/export.csv" download="export.csv">Download CSV</a>',
    '<label for="upload-input">Upload CSV</label>',
    '<input id="upload-input" type="file" aria-label="Upload CSV" />',
  ].join("\n    ");
}

export function buildDownloadUploadFixtureScript(): string {
  return [
    'const upload = document.getElementById("upload-input");',
    'upload.addEventListener("change", () => {',
    "  const file = upload.files && upload.files[0];",
    '  const name = file ? file.name : "missing";',
    '  document.title = "uploaded:" + name;',
    '  status.textContent = "uploaded:" + name;',
    "});",
  ].join("\n      ");
}

export async function verifyBrowserSmokeMultiTarget(input: {
  daemonUrl: string;
  threadId: string;
  sessionId: string;
  startUrl: string;
  originalTargetId?: string;
  label: string;
  client: BrowserSmokeHttpClient;
}): Promise<{ targetCount: number }> {
  const initialTargets = await getSessionTargets(input);
  const originalTargetId = input.originalTargetId
    ?? initialTargets.find((target) => target.active === true)?.targetId
    ?? initialTargets[0]?.targetId;
  if (!originalTargetId) {
    throw new Error(`${input.label} multi-target smoke could not resolve the original target`);
  }

  const opened = (await input.client.postJson(
    `${input.daemonUrl}/browser-sessions/${encodeURIComponent(input.sessionId)}/targets`,
    {
      threadId: input.threadId,
      url: buildSecondaryTargetUrl(input.startUrl),
    }
  )) as BrowserSmokeTarget;
  const openedTargetId = requireString(opened.targetId, `${input.label} secondary targetId`);
  if (openedTargetId === originalTargetId) {
    throw new Error(`${input.label} multi-target smoke reused the original target id`);
  }

  const targetsAfterOpen = await getSessionTargets(input);
  if (!targetsAfterOpen.some((target) => target.targetId === originalTargetId)) {
    throw new Error(`${input.label} multi-target smoke lost the original target`);
  }
  if (!targetsAfterOpen.some((target) => target.targetId === openedTargetId)) {
    throw new Error(`${input.label} multi-target smoke did not list the secondary target`);
  }

  const activated = (await input.client.postJson(
    `${input.daemonUrl}/browser-sessions/${encodeURIComponent(input.sessionId)}/activate-target`,
    {
      threadId: input.threadId,
      targetId: originalTargetId,
    }
  )) as BrowserSmokeTarget;
  if (requireString(activated.targetId, `${input.label} activated targetId`) !== originalTargetId) {
    throw new Error(`${input.label} multi-target smoke activated the wrong target`);
  }

  const finalTargets = await getSessionTargets(input);
  if (finalTargets.length < 2) {
    throw new Error(`${input.label} multi-target smoke expected at least two targets, saw ${finalTargets.length}`);
  }
  return {
    targetCount: finalTargets.length,
  };
}

export function resolveDownloadSmokeArtifact(
  response: BrowserSmokeResponse,
  label: string
): { artifactId: string; downloadArtifactCount: number } {
  const downloadTraces = response.trace?.filter((entry) =>
    entry.kind === "download" &&
    entry.output?.matched === true &&
    entry.output?.fileName === "export.csv" &&
    typeof entry.output?.sizeBytes === "number" &&
    entry.output.sizeBytes > 0
  ) ?? [];
  if (downloadTraces.length !== 1) {
    throw new Error(`${label} download smoke expected exactly one completed download trace, saw ${downloadTraces.length}`);
  }

  const artifactIds = Array.isArray(response.artifactIds) ? response.artifactIds : [];
  const downloadArtifactIds = artifactIds.filter(isDownloadArtifactId);
  if (downloadArtifactIds.length !== downloadTraces.length) {
    throw new Error(
      `${label} download smoke expected ${downloadTraces.length} downloaded-file browser artifact, saw ${downloadArtifactIds.length}`
    );
  }

  return {
    artifactId: downloadArtifactIds[0]!,
    downloadArtifactCount: downloadArtifactIds.length,
  };
}

export function countUploadTraceEntries(response: BrowserSmokeResponse, label: string): number {
  const uploadTraceEntries = response.trace?.filter((entry) =>
    entry.kind === "upload" &&
    entry.output?.fileName === "export.csv" &&
    typeof entry.output?.sizeBytes === "number" &&
    entry.output.sizeBytes > 0
  ) ?? [];
  if (uploadTraceEntries.length < 1) {
    throw new Error(`${label} upload smoke did not record completed upload trace metadata`);
  }
  return uploadTraceEntries.length;
}

export function isUploadedExportTitle(value: string): boolean {
  return value.startsWith("uploaded:") && value.endsWith("export.csv");
}

export function collectBrowserSmokeTraceKinds(responses: BrowserSmokeResponse[]): string[] {
  const kinds = new Set<string>();
  for (const response of responses) {
    for (const entry of response.trace ?? []) {
      if (entry.kind) {
        kinds.add(entry.kind);
      }
    }
  }
  return [...kinds].sort();
}

export function assertBrowserSmokeActionParity(
  responses: BrowserSmokeResponse[],
  label: string
): string[] {
  const observedKinds = collectBrowserSmokeTraceKinds(responses);
  const observed = new Set(observedKinds);
  const missing = BROWSER_LONG_CHAIN_ACTION_KINDS.filter((kind) => !observed.has(kind));
  if (missing.length > 0) {
    throw new Error(`${label} smoke missing long-chain action kinds: ${missing.join(",")}`);
  }
  return observedKinds;
}

async function getSessionTargets(input: {
  daemonUrl: string;
  threadId: string;
  sessionId: string;
  client: BrowserSmokeHttpClient;
}): Promise<BrowserSmokeTarget[]> {
  return (await input.client.getJson(
    `${input.daemonUrl}/browser-sessions/${encodeURIComponent(input.sessionId)}/targets?threadId=${encodeURIComponent(input.threadId)}`
  )) as BrowserSmokeTarget[];
}

function buildSecondaryTargetUrl(startUrl: string): string {
  const url = new URL(startUrl);
  url.searchParams.set("target", "secondary");
  return url.toString();
}

function isDownloadArtifactId(artifactId: string): boolean {
  return artifactId.endsWith(":download") || /:relay-download:\d+$/.test(artifactId);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.length) {
    throw new Error(`missing ${label}`);
  }
  return value;
}
