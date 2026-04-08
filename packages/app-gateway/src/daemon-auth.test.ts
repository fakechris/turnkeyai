import assert from "node:assert/strict";
import test from "node:test";

import {
  authorizeDaemonRequest,
  createRelayPeerIdentityBindingStore,
  resolveDaemonAuthConfig,
  resolveDaemonRequestAccess,
} from "./daemon-auth";

test("resolveDaemonAuthConfig preserves legacy single-token compatibility", () => {
  const config = resolveDaemonAuthConfig({
    TURNKEYAI_DAEMON_TOKEN: " legacy-token ",
  });

  assert.deepEqual(config, {
    readToken: "legacy-token",
    operatorToken: "legacy-token",
    relayPeerToken: "legacy-token",
    adminToken: "legacy-token",
    authMode: "token",
  });
});

test("resolveDaemonAuthConfig supports layered tokens", () => {
  const config = resolveDaemonAuthConfig({
    TURNKEYAI_DAEMON_READ_TOKEN: "read-token",
    TURNKEYAI_DAEMON_OPERATOR_TOKEN: "operator-token",
    TURNKEYAI_BROWSER_RELAY_TOKEN: "relay-token",
    TURNKEYAI_DAEMON_ADMIN_TOKEN: "admin-token",
  });

  assert.deepEqual(config, {
    readToken: "read-token",
    operatorToken: "operator-token",
    relayPeerToken: "relay-token",
    adminToken: "admin-token",
    authMode: "token-layered",
  });
});

test("resolveDaemonRequestAccess classifies representative route matrix entries", () => {
  const cases = [
    { method: "GET", pathname: "/health", expected: "public" },
    { method: "GET", pathname: "/runtime-summary", expected: "read" },
    { method: "GET", pathname: "/runtime-worker-sessions", expected: "read" },
    { method: "GET", pathname: "/scheduled-tasks", expected: "read" },
    { method: "POST", pathname: "/messages", expected: "operator" },
    { method: "POST", pathname: "/scheduled-tasks", expected: "operator" },
    { method: "POST", pathname: "/scheduled-tasks/trigger-due", expected: "operator" },
    { method: "POST", pathname: "/browser-sessions/spawn", expected: "operator" },
    { method: "GET", pathname: "/browser-sessions", expected: "operator" },
    { method: "POST", pathname: "/recovery-runs/run-1/retry", expected: "operator" },
    { method: "POST", pathname: "/replay-recoveries/thread-1", expected: "operator" },
    { method: "GET", pathname: "/validation-ops", expected: "admin" },
    { method: "POST", pathname: "/validation-profiles/run", expected: "admin" },
    { method: "POST", pathname: "/transport-soak/run", expected: "admin" },
    { method: "POST", pathname: "/relay/peers/register", expected: "relay-peer" },
    { method: "POST", pathname: "/relay/peers/peer-1/heartbeat", expected: "relay-peer" },
    { method: "GET", pathname: "/relay/targets", expected: "admin" },
  ] as const;

  for (const entry of cases) {
    assert.equal(
      resolveDaemonRequestAccess({ method: entry.method } as never, { pathname: entry.pathname } as URL),
      entry.expected,
      `${entry.method} ${entry.pathname}`
    );
  }
});

test("authorizeDaemonRequest enforces layered access while keeping health public", () => {
  const config = resolveDaemonAuthConfig({
    TURNKEYAI_DAEMON_READ_TOKEN: "read-token",
    TURNKEYAI_DAEMON_OPERATOR_TOKEN: "operator-token",
    TURNKEYAI_BROWSER_RELAY_TOKEN: "relay-token",
    TURNKEYAI_DAEMON_ADMIN_TOKEN: "admin-token",
  });

  assert.equal(
    authorizeDaemonRequest(
      { method: "GET", headers: {} } as never,
      new URL("http://127.0.0.1/health"),
      config
    ).authorized,
    true
  );

  assert.equal(
    authorizeDaemonRequest(
      { method: "GET", headers: { authorization: "Bearer read-token" } } as never,
      new URL("http://127.0.0.1/runtime-summary"),
      config
    ).authorized,
    true
  );

  assert.equal(
    authorizeDaemonRequest(
      { method: "POST", headers: { authorization: "Bearer read-token" } } as never,
      new URL("http://127.0.0.1/messages"),
      config
    ).authorized,
    false
  );

  assert.equal(
    authorizeDaemonRequest(
      { method: "POST", headers: { authorization: "Bearer operator-token" } } as never,
      new URL("http://127.0.0.1/messages"),
      config
    ).authorized,
    true
  );

  assert.equal(
    authorizeDaemonRequest(
      { method: "POST", headers: { authorization: "Bearer operator-token" } } as never,
      new URL("http://127.0.0.1/validation-profiles/run"),
      config
    ).authorized,
    false
  );

  const adminResult = authorizeDaemonRequest(
    { method: "POST", headers: { "x-turnkeyai-token": "admin-token" } } as never,
    new URL("http://127.0.0.1/validation-profiles/run"),
    config
  );
  assert.equal(adminResult.authorized, true);
  assert.equal(adminResult.grantedAccess, "admin");
  assert.equal(adminResult.requiredAccess, "admin");

  const relayPeerResult = authorizeDaemonRequest(
    { method: "POST", headers: { authorization: "Bearer relay-token" } } as never,
    new URL("http://127.0.0.1/relay/peers/register"),
    config
  );
  assert.equal(relayPeerResult.authorized, true);
  assert.equal(relayPeerResult.grantedAccess, "relay-peer");
  assert.equal(relayPeerResult.requiredAccess, "relay-peer");
  assert.equal(relayPeerResult.token, "relay-token");

  const relayPeerReadFailure = authorizeDaemonRequest(
    { method: "GET", headers: { authorization: "Bearer relay-token" } } as never,
    new URL("http://127.0.0.1/relay/peers"),
    config
  );
  assert.equal(relayPeerReadFailure.authorized, false);
  assert.equal(relayPeerReadFailure.grantedAccess, "relay-peer");
  assert.equal(relayPeerReadFailure.requiredAccess, "admin");
});

test("authorizeDaemonRequest returns required access for layered failures", () => {
  const config = resolveDaemonAuthConfig({
    TURNKEYAI_DAEMON_READ_TOKEN: "read-token",
    TURNKEYAI_DAEMON_OPERATOR_TOKEN: "operator-token",
    TURNKEYAI_BROWSER_RELAY_TOKEN: "relay-token",
    TURNKEYAI_DAEMON_ADMIN_TOKEN: "admin-token",
  });

  const operatorFailure = authorizeDaemonRequest(
    { method: "POST", headers: { authorization: "Bearer read-token" } } as never,
    new URL("http://127.0.0.1/browser-sessions/spawn"),
    config
  );
  assert.equal(operatorFailure.authorized, false);
  assert.equal(operatorFailure.requiredAccess, "operator");
  assert.equal(operatorFailure.grantedAccess, "read");

  const adminFailure = authorizeDaemonRequest(
    { method: "POST", headers: { authorization: "Bearer operator-token" } } as never,
    new URL("http://127.0.0.1/relay/peers/register"),
    config
  );
  assert.equal(adminFailure.authorized, false);
  assert.equal(adminFailure.requiredAccess, "relay-peer");
  assert.equal(adminFailure.grantedAccess, "operator");

  const relayPeerFailure = authorizeDaemonRequest(
    { method: "POST", headers: { authorization: "Bearer read-token" } } as never,
    new URL("http://127.0.0.1/relay/peers/register"),
    config
  );
  assert.equal(relayPeerFailure.authorized, false);
  assert.equal(relayPeerFailure.requiredAccess, "relay-peer");
  assert.equal(relayPeerFailure.grantedAccess, "read");
});

test("relay peer identity binding store binds relay-peer tokens to one peer id", () => {
  const store = createRelayPeerIdentityBindingStore({
    now: () => 100,
  });
  const authorization = {
    authorized: true,
    requiredAccess: "relay-peer" as const,
    grantedAccess: "relay-peer" as const,
    authMode: "token-layered" as const,
    token: "relay-token",
  };

  const bound = store.bindPeerIdentity(authorization, "peer-1");
  assert.equal(bound.ok, true);
  assert.deepEqual(store.getBinding("relay-token", "peer-1"), {
    peerId: "peer-1",
    boundAt: 100,
    lastSeenAt: 100,
  });

  const authorized = store.authorizePeerIdentity(authorization, "peer-1");
  assert.equal(authorized.ok, true);

  const mismatch = store.authorizePeerIdentity(authorization, "peer-2");
  assert.deepEqual(mismatch, {
    ok: false,
    statusCode: 403,
    error: "relay peer token is not bound to a peerId",
  });
});

test("relay peer identity binding store allows multiple peer ids for the same token", () => {
  let now = 100;
  const store = createRelayPeerIdentityBindingStore({
    now: () => now,
  });
  const authorization = {
    authorized: true,
    requiredAccess: "relay-peer" as const,
    grantedAccess: "relay-peer" as const,
    authMode: "token-layered" as const,
    token: "relay-token",
  };

  const first = store.bindPeerIdentity(authorization, "peer-1");
  now = 200;
  const second = store.bindPeerIdentity(authorization, "peer-2");

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.deepEqual(store.getBinding("relay-token", "peer-1"), {
    peerId: "peer-1",
    boundAt: 100,
    lastSeenAt: 100,
  });
  assert.deepEqual(store.getBinding("relay-token", "peer-2"), {
    peerId: "peer-2",
    boundAt: 200,
    lastSeenAt: 200,
  });
  assert.equal(store.authorizePeerIdentity(authorization, "peer-1").ok, true);
  assert.equal(store.authorizePeerIdentity(authorization, "peer-2").ok, true);
});

test("relay peer identity binding store bypasses admin and disabled auth", () => {
  const store = createRelayPeerIdentityBindingStore();

  assert.deepEqual(
    store.authorizePeerIdentity(
      {
        authorized: true,
        requiredAccess: "relay-peer",
        grantedAccess: "admin",
        authMode: "token-layered",
        token: "admin-token",
      },
      "peer-1"
    ),
    { ok: true }
  );

  assert.deepEqual(
    store.authorizePeerIdentity(
      {
        authorized: true,
        requiredAccess: "relay-peer",
        authMode: "disabled",
      },
      "peer-1"
    ),
    { ok: true }
  );
});
