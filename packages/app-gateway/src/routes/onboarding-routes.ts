import type http from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { writeJsonFileAtomic } from "@turnkeyai/shared-utils/file-store-utils";

import { readOptionalJsonBodySafe, sendJson } from "../http-helpers";

export interface OnboardingState {
  completedAt: number | null;
  transportChosen: string | null;
  transportVerifiedAt: number | null;
  step: string | null;
  updatedAt: number | null;
}

export interface OnboardingRouteDeps {
  stateFile: string;
  clock: { now(): number };
}

interface OnboardingUpdateBody {
  completedAt?: unknown;
  transportChosen?: unknown;
  transportVerifiedAt?: unknown;
  step?: unknown;
}

const DEFAULT_STATE: OnboardingState = {
  completedAt: null,
  transportChosen: null,
  transportVerifiedAt: null,
  step: null,
  updatedAt: null,
};

export async function handleOnboardingRoutes(input: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  deps: OnboardingRouteDeps;
}): Promise<boolean> {
  const { req, res, url, deps } = input;
  if (url.pathname !== "/onboarding/state") {
    return false;
  }

  if (req.method === "GET") {
    sendJson(res, 200, await readOnboardingState(deps.stateFile));
    return true;
  }

  if (req.method === "PUT") {
    const bodyResult = await readOptionalJsonBodySafe<OnboardingUpdateBody>(req);
    if (!bodyResult.ok) {
      sendJson(res, 400, { error: bodyResult.error });
      return true;
    }
    const parsed = parseOnboardingUpdate(bodyResult.value);
    if (!parsed.ok) {
      sendJson(res, 400, { error: parsed.error });
      return true;
    }
    const current = await readOnboardingState(deps.stateFile);
    const next: OnboardingState = {
      ...current,
      ...parsed.value,
      updatedAt: deps.clock.now(),
    };
    await mkdir(path.dirname(deps.stateFile), { recursive: true });
    await writeJsonFileAtomic(deps.stateFile, next);
    sendJson(res, 200, next);
    return true;
  }

  return false;
}

async function readOnboardingState(stateFile: string): Promise<OnboardingState> {
  try {
    const raw = await readFile(stateFile, "utf8");
    return normalizeStoredState(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function normalizeStoredState(value: unknown): OnboardingState {
  if (!value || typeof value !== "object") {
    return { ...DEFAULT_STATE };
  }
  const record = value as Record<string, unknown>;
  return {
    completedAt: readFiniteNumberOrNull(record.completedAt),
    transportChosen: readNonEmptyStringOrNull(record.transportChosen),
    transportVerifiedAt: readFiniteNumberOrNull(record.transportVerifiedAt),
    step: readNonEmptyStringOrNull(record.step),
    updatedAt: readFiniteNumberOrNull(record.updatedAt),
  };
}

function parseOnboardingUpdate(
  value: OnboardingUpdateBody
): { ok: true; value: Partial<OnboardingState> } | { ok: false; error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "body must be an object" };
  }
  const update: Partial<OnboardingState> = {};
  if ("completedAt" in value) {
    const completedAt = parseNullableFiniteNumber(value.completedAt, "completedAt");
    if (!completedAt.ok) return completedAt;
    update.completedAt = completedAt.value;
  }
  if ("transportVerifiedAt" in value) {
    const transportVerifiedAt = parseNullableFiniteNumber(value.transportVerifiedAt, "transportVerifiedAt");
    if (!transportVerifiedAt.ok) return transportVerifiedAt;
    update.transportVerifiedAt = transportVerifiedAt.value;
  }
  if ("transportChosen" in value) {
    const transportChosen = parseNullableNonEmptyString(value.transportChosen, "transportChosen");
    if (!transportChosen.ok) return transportChosen;
    update.transportChosen = transportChosen.value;
  }
  if ("step" in value) {
    const step = parseNullableNonEmptyString(value.step, "step");
    if (!step.ok) return step;
    update.step = step.value;
  }
  return { ok: true, value: update };
}

function parseNullableFiniteNumber(
  value: unknown,
  field: string
): { ok: true; value: number | null } | { ok: false; error: string } {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return { ok: false, error: `${field} must be a non-negative finite number or null` };
  }
  return { ok: true, value };
}

function parseNullableNonEmptyString(
  value: unknown,
  field: string
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string" || value.trim().length === 0) {
    return { ok: false, error: `${field} must be a non-empty string or null` };
  }
  return { ok: true, value: value.trim() };
}

function readFiniteNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function readNonEmptyStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
