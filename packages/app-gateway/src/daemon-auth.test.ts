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

test("resolveDaemonRequestAccess classifies public, read, operator, and admin routes", () => {
  assert.equal(resolveDaemonRequestAccess({ method: "GET" } as never, { pathname: "/health" } as URL), "public");
  assert.equal(resolveDaemonRequestAccess({ method: "GET" } as never, { pathname: "/runtime-summary" } as URL), "read");
  assert.equal(resolveDaemonRequestAccess({ method: "POST" } as never, { pathname: "/messages" } as URL), "operator");
  assert.equal(
    resolveDaemonRequestAccess({ method: "POST" } as never, { pathname: "/recovery-runs/run-1/retry" } as URL),
    "operator"
  );
  assert.equal(resolveDaemonRequestAccess({ method: "POST" } as never, { pathname: "/validation-profiles/run" } as URL), "admin");
  assert.equal(resolveDaemonRequestAccess({ method: "POST" } as never, { pathname: "/relay/peers/register" } as URL), "admin");
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
