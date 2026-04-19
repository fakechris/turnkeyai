import type http from "node:http";

import type { BrowserTaskResult } from "@turnkeyai/core-types/team";
import type { RelayControlPlane } from "@turnkeyai/browser-bridge/transport/transport-adapter";

import type {
  DaemonAuthorizationResult,
  RelayPeerIdentityBindingResult,
} from "../daemon-auth";
import { readJsonBodySafe, readOptionalJsonBodySafe, sendJson } from "../http-helpers";

const RELAY_TARGET_STATUSES = new Set(["open", "attached", "detached", "closed"]);
const RELAY_ACTION_RESULT_STATUSES = new Set(["completed", "failed"]);
const MAX_RELAY_PULL_WAIT_MS = 25_000;

export async function handleRelayRoutes(input: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  relayGateway: RelayControlPlane | null;
  authorization: DaemonAuthorizationResult;
  relayPeerBindingStore: {
    bindPeerIdentity(
      authorization: DaemonAuthorizationResult,
      peerId: string
    ): RelayPeerIdentityBindingResult;
    authorizePeerIdentity(
      authorization: DaemonAuthorizationResult,
      peerId: string
    ): RelayPeerIdentityBindingResult;
  };
}): Promise<boolean> {
  const { req, res, url, relayGateway, authorization, relayPeerBindingStore } = input;

  if (req.method === "GET" && url.pathname === "/relay/peers") {
    if (!relayGateway) {
      sendJson(res, 503, { error: "relay browser transport is not active" });
      return true;
    }
    sendJson(res, 200, relayGateway.listPeers());
    return true;
  }

  if (req.method === "POST" && url.pathname === "/relay/peers/register") {
    if (!relayGateway) {
      sendJson(res, 503, { error: "relay browser transport is not active" });
      return true;
    }
    const bodyResult = await readJsonBodySafe<{
      peerId?: string;
      label?: string;
      capabilities?: string[];
      transportLabel?: string;
    }>(req);
    if (!bodyResult.ok) {
      sendJson(res, 400, { error: bodyResult.error });
      return true;
    }
    const body = bodyResult.value;
    if (!body.peerId?.trim()) {
      sendJson(res, 400, { error: "peerId is required" });
      return true;
    }
    if (body.label !== undefined && !body.label.trim()) {
      sendJson(res, 400, { error: "label must be a non-empty string when provided" });
      return true;
    }
    if (body.transportLabel !== undefined && !body.transportLabel.trim()) {
      sendJson(res, 400, { error: "transportLabel must be a non-empty string when provided" });
      return true;
    }
    if (
      body.capabilities !== undefined &&
      (!Array.isArray(body.capabilities) || body.capabilities.some((capability) => typeof capability !== "string" || capability.trim().length === 0))
    ) {
      sendJson(res, 400, { error: "capabilities must contain non-empty strings" });
      return true;
    }
    const peerIdentity = relayPeerBindingStore.bindPeerIdentity(authorization, body.peerId);
    if (!peerIdentity.ok) {
      sendJson(res, peerIdentity.statusCode ?? 403, { error: peerIdentity.error ?? "forbidden" });
      return true;
    }
    sendJson(
      res,
      201,
      relayGateway.registerPeer({
        peerId: body.peerId,
        ...(body.label?.trim() ? { label: body.label.trim() } : {}),
        ...(Array.isArray(body.capabilities)
          ? {
              capabilities: body.capabilities
                .filter((capability): capability is string => typeof capability === "string")
                .map((capability) => capability.trim())
                .filter((capability) => capability.length > 0),
            }
          : {}),
        ...(body.transportLabel?.trim() ? { transportLabel: body.transportLabel.trim() } : {}),
      })
    );
    return true;
  }

  const relayPeerHeartbeatMatch = url.pathname.match(/^\/relay\/peers\/([^/]+)\/heartbeat$/);
  if (req.method === "POST" && relayPeerHeartbeatMatch) {
    if (!relayGateway) {
      sendJson(res, 503, { error: "relay browser transport is not active" });
      return true;
    }
    const peerId = decodeURIComponent(relayPeerHeartbeatMatch[1]!);
    const peerIdentity = relayPeerBindingStore.authorizePeerIdentity(authorization, peerId);
    if (!peerIdentity.ok) {
      sendJson(res, peerIdentity.statusCode ?? 403, { error: peerIdentity.error ?? "forbidden" });
      return true;
    }
    sendJson(res, 200, relayGateway.heartbeatPeer(peerId));
    return true;
  }

  const relayPeerTargetsMatch = url.pathname.match(/^\/relay\/peers\/([^/]+)\/targets\/report$/);
  if (req.method === "POST" && relayPeerTargetsMatch) {
    if (!relayGateway) {
      sendJson(res, 503, { error: "relay browser transport is not active" });
      return true;
    }
    const peerId = decodeURIComponent(relayPeerTargetsMatch[1]!);
    const peerIdentity = relayPeerBindingStore.authorizePeerIdentity(authorization, peerId);
    if (!peerIdentity.ok) {
      sendJson(res, peerIdentity.statusCode ?? 403, { error: peerIdentity.error ?? "forbidden" });
      return true;
    }
    const bodyResult = await readJsonBodySafe<{
      targets?: Array<{
        relayTargetId?: string;
        url?: string;
        title?: string;
        status?: "open" | "attached" | "detached" | "closed";
      }>;
    }>(req);
    if (!bodyResult.ok) {
      sendJson(res, 400, { error: bodyResult.error });
      return true;
    }
    const body = bodyResult.value;
    if (!Array.isArray(body.targets)) {
      sendJson(res, 400, { error: "targets array is required" });
      return true;
    }
    const targets = body.targets
      .filter((target): target is NonNullable<typeof target> => Boolean(target) && typeof target === "object")
      .map((target) => ({
        relayTargetId: target.relayTargetId?.trim() ?? "",
        url: target.url?.trim() ?? "",
        title: target.title?.trim(),
        status: target.status,
      }));
    if (targets.length !== body.targets.length || targets.some((target) => target.relayTargetId.length === 0)) {
      sendJson(res, 400, { error: "each target must include a non-empty relayTargetId" });
      return true;
    }
    if (targets.some((target) => target.status !== undefined && !RELAY_TARGET_STATUSES.has(target.status))) {
      sendJson(res, 400, { error: "each target status must be open, attached, detached, or closed" });
      return true;
    }
    sendJson(
      res,
      200,
      relayGateway.reportTargets(
        peerId,
        targets.map((target) => ({
          relayTargetId: target.relayTargetId,
          url: target.url,
          ...(target.title ? { title: target.title } : {}),
          ...(target.status ? { status: target.status } : {}),
        }))
      )
    );
    return true;
  }

  if (req.method === "GET" && url.pathname === "/relay/targets") {
    if (!relayGateway) {
      sendJson(res, 503, { error: "relay browser transport is not active" });
      return true;
    }
    const peerId = url.searchParams.get("peerId");
    sendJson(
      res,
      200,
      relayGateway.listTargets(peerId?.trim() ? { peerId: peerId.trim() } : undefined)
    );
    return true;
  }

  if (req.method === "GET" && url.pathname === "/relay/actions") {
    if (!relayGateway) {
      sendJson(res, 503, { error: "relay browser transport is not active" });
      return true;
    }
    sendJson(res, 200, relayGateway.listActionRequests());
    return true;
  }

  const relayPeerPullActionsMatch = url.pathname.match(/^\/relay\/peers\/([^/]+)\/pull-actions$/);
  if (req.method === "POST" && relayPeerPullActionsMatch) {
    if (!relayGateway) {
      sendJson(res, 503, { error: "relay browser transport is not active" });
      return true;
    }
    const peerId = decodeURIComponent(relayPeerPullActionsMatch[1]!);
    const peerIdentity = relayPeerBindingStore.authorizePeerIdentity(authorization, peerId);
    if (!peerIdentity.ok) {
      sendJson(res, peerIdentity.statusCode ?? 403, { error: peerIdentity.error ?? "forbidden" });
      return true;
    }
    const bodyResult = await readOptionalJsonBodySafe<{ waitMs?: number }>(req);
    if (!bodyResult.ok) {
      sendJson(res, 400, { error: bodyResult.error });
      return true;
    }
    const waitMs = normalizeRelayPullWaitMs(bodyResult.value.waitMs);
    if (waitMs === null) {
      sendJson(res, 400, { error: "waitMs must be a non-negative finite number" });
      return true;
    }
    const actionRequest =
      waitMs > 0 && relayGateway.pullNextActionRequestWait
        ? await relayGateway.pullNextActionRequestWait(peerId, waitMs)
        : relayGateway.pullNextActionRequest(peerId);
    sendJson(
      res,
      200,
      actionRequest
    );
    return true;
  }

  const relayPeerActionResultsMatch = url.pathname.match(/^\/relay\/peers\/([^/]+)\/action-results$/);
  if (req.method === "POST" && relayPeerActionResultsMatch) {
    if (!relayGateway) {
      sendJson(res, 503, { error: "relay browser transport is not active" });
      return true;
    }
    const peerId = decodeURIComponent(relayPeerActionResultsMatch[1]!);
    const peerIdentity = relayPeerBindingStore.authorizePeerIdentity(authorization, peerId);
    if (!peerIdentity.ok) {
      sendJson(res, peerIdentity.statusCode ?? 403, { error: peerIdentity.error ?? "forbidden" });
      return true;
    }
    const bodyResult = await readJsonBodySafe<{
      actionRequestId?: string;
      browserSessionId?: string;
      taskId?: string;
      relayTargetId?: string;
      claimToken?: string;
      url?: string;
      title?: string;
      status?: "completed" | "failed";
      page?: BrowserTaskResult["page"];
      trace?: BrowserTaskResult["trace"];
      screenshotPaths?: string[];
      screenshotPayloads?: Array<{
        label?: string;
        mimeType?: string;
        dataBase64?: string;
      }>;
      artifactIds?: string[];
      errorMessage?: string;
    }>(req);
    if (!bodyResult.ok) {
      sendJson(res, 400, { error: bodyResult.error });
      return true;
    }
    const body = bodyResult.value;
    const actionRequestId = typeof body.actionRequestId === "string" ? body.actionRequestId.trim() : "";
    const browserSessionId = typeof body.browserSessionId === "string" ? body.browserSessionId.trim() : "";
    const taskId = typeof body.taskId === "string" ? body.taskId.trim() : "";
    const relayTargetId = typeof body.relayTargetId === "string" ? body.relayTargetId.trim() : "";
    const claimToken = typeof body.claimToken === "string" ? body.claimToken.trim() : "";
    const url = typeof body.url === "string" ? body.url.trim() : "";
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const errorMessage = typeof body.errorMessage === "string" ? body.errorMessage.trim() : "";
    if (!actionRequestId || !browserSessionId || !taskId || !relayTargetId || !claimToken) {
      sendJson(res, 400, {
        error: "actionRequestId, browserSessionId, taskId, relayTargetId, and claimToken are required",
      });
      return true;
    }
    if (!url) {
      sendJson(res, 400, { error: "url is required" });
      return true;
    }
    if (!body.status || !RELAY_ACTION_RESULT_STATUSES.has(body.status)) {
      sendJson(res, 400, { error: "status must be completed or failed" });
      return true;
    }
    if (body.trace !== undefined && !Array.isArray(body.trace)) {
      sendJson(res, 400, { error: "trace must be an array when provided" });
      return true;
    }
    if (
      body.screenshotPaths !== undefined &&
      (!Array.isArray(body.screenshotPaths) ||
        body.screenshotPaths.some((path) => typeof path !== "string" || path.trim().length === 0))
    ) {
      sendJson(res, 400, { error: "screenshotPaths must contain non-empty strings" });
      return true;
    }
    if (
      body.artifactIds !== undefined &&
      (!Array.isArray(body.artifactIds) ||
        body.artifactIds.some((artifactId) => typeof artifactId !== "string" || artifactId.trim().length === 0))
    ) {
      sendJson(res, 400, { error: "artifactIds must contain non-empty strings" });
      return true;
    }
    if (
      body.screenshotPayloads !== undefined &&
      (!Array.isArray(body.screenshotPayloads) ||
        body.screenshotPayloads.some(
          (payload) =>
            !payload ||
            typeof payload !== "object" ||
            typeof payload.mimeType !== "string" ||
            payload.mimeType.trim().length === 0 ||
            typeof payload.dataBase64 !== "string" ||
            payload.dataBase64.length === 0 ||
            (payload.label !== undefined &&
              (typeof payload.label !== "string" || payload.label.trim().length === 0))
        ))
    ) {
      sendJson(res, 400, {
        error: "screenshotPayloads must contain objects with non-empty mimeType and dataBase64",
      });
      return true;
    }
    sendJson(
      res,
      200,
      relayGateway.submitActionResult({
        actionRequestId,
        peerId,
        browserSessionId,
        taskId,
        relayTargetId,
        claimToken,
        url,
        ...(title ? { title } : {}),
        status: body.status,
        ...(body.page ? { page: body.page } : {}),
        trace: Array.isArray(body.trace) ? body.trace : [],
        screenshotPaths: Array.isArray(body.screenshotPaths)
          ? body.screenshotPaths
              .filter((path): path is string => typeof path === "string")
              .map((path) => path.trim())
              .filter((path) => path.length > 0)
          : [],
        screenshotPayloads: Array.isArray(body.screenshotPayloads)
          ? body.screenshotPayloads
              .filter(
                (payload): payload is { label?: string; mimeType: string; dataBase64: string } =>
                  Boolean(payload) &&
                  typeof payload === "object" &&
                  typeof payload.mimeType === "string" &&
                  typeof payload.dataBase64 === "string" &&
                  (payload.label === undefined || typeof payload.label === "string")
              )
              .map((payload) => ({
                ...(typeof payload.label === "string" && payload.label.trim() ? { label: payload.label.trim() } : {}),
                mimeType: payload.mimeType.trim(),
                dataBase64: payload.dataBase64,
              }))
          : [],
        artifactIds: Array.isArray(body.artifactIds)
          ? body.artifactIds
              .filter((artifactId): artifactId is string => typeof artifactId === "string")
              .map((artifactId) => artifactId.trim())
              .filter((artifactId) => artifactId.length > 0)
          : [],
        ...(errorMessage ? { errorMessage } : {}),
      })
    );
    return true;
  }

  return false;
}

function normalizeRelayPullWaitMs(value: number | undefined): number | null {
  if (value === undefined) {
    return 0;
  }
  if (!Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.min(MAX_RELAY_PULL_WAIT_MS, Math.trunc(value));
}
