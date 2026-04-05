import assert from "node:assert/strict";
import test from "node:test";

import { authorizeDaemonRequest, resolveDaemonAuthConfig, resolveDaemonRequestAccess } from "./daemon-auth";

test("resolveDaemonAuthConfig preserves legacy single-token compatibility", () => {
  const config = resolveDaemonAuthConfig({
    TURNKEYAI_DAEMON_TOKEN: " legacy-token ",
  });

  assert.deepEqual(config, {
    readToken: "legacy-token",
    operatorToken: "legacy-token",
    adminToken: "legacy-token",
    authMode: "token",
  });
});

test("resolveDaemonAuthConfig supports layered tokens", () => {
  const config = resolveDaemonAuthConfig({
    TURNKEYAI_DAEMON_READ_TOKEN: "read-token",
    TURNKEYAI_DAEMON_OPERATOR_TOKEN: "operator-token",
    TURNKEYAI_DAEMON_ADMIN_TOKEN: "admin-token",
  });

  assert.deepEqual(config, {
    readToken: "read-token",
    operatorToken: "operator-token",
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
    { method: "POST", pathname: "/relay/peers/register", expected: "admin" },
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
});

test("authorizeDaemonRequest returns required access for layered failures", () => {
  const config = resolveDaemonAuthConfig({
    TURNKEYAI_DAEMON_READ_TOKEN: "read-token",
    TURNKEYAI_DAEMON_OPERATOR_TOKEN: "operator-token",
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
  assert.equal(adminFailure.requiredAccess, "admin");
  assert.equal(adminFailure.grantedAccess, "operator");
});
