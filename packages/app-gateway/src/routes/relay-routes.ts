import type http from "node:http";

import type { BrowserTaskResult } from "@turnkeyai/core-types/team";
import type { RelayControlPlane } from "@turnkeyai/browser-bridge/transport/transport-adapter";

import type {
  DaemonAuthorizationResult,
  RelayPeerIdentityBindingResult,
} from "../daemon-auth";
import { readJsonBodySafe, sendJson } from "../http-helpers";

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
    sendJson(
      res,
      200,
      relayGateway.pullNextActionRequest(peerId)
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
    if (!body.actionRequestId?.trim() || !body.browserSessionId?.trim() || !body.taskId?.trim() || !body.relayTargetId?.trim()) {
      sendJson(res, 400, {
        error: "actionRequestId, browserSessionId, taskId, and relayTargetId are required",
      });
      return true;
    }
    if (!body.url?.trim()) {
      sendJson(res, 400, { error: "url is required" });
      return true;
    }
    if (!body.status) {
      sendJson(res, 400, { error: "status is required" });
      return true;
    }
    sendJson(
      res,
      200,
      relayGateway.submitActionResult({
        actionRequestId: body.actionRequestId.trim(),
        peerId,
        browserSessionId: body.browserSessionId.trim(),
        taskId: body.taskId.trim(),
        relayTargetId: body.relayTargetId.trim(),
        url: body.url.trim(),
        ...(body.title?.trim() ? { title: body.title.trim() } : {}),
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
                  typeof payload.dataBase64 === "string"
              )
              .map((payload) => ({
                ...(payload.label?.trim() ? { label: payload.label.trim() } : {}),
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
        ...(body.errorMessage?.trim() ? { errorMessage: body.errorMessage.trim() } : {}),
      })
    );
    return true;
  }

  return false;
}
