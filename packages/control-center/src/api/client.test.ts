import assert from "node:assert/strict";
import test from "node:test";

import { ApiError, UnauthorizedError, createApiClient } from "./client";

test("api client surfaces JSON error bodies instead of generic status text", async () => {
  const restore = mockFetch(
    new Response(JSON.stringify({ error: "recovery run requires approval before it can continue" }), {
      status: 409,
      headers: { "content-type": "application/json" },
    })
  );
  try {
    const client = createApiClient({ getToken: () => "operator-token" });
    await assert.rejects(
      () => client.post("/recovery-runs/run-1/retry?threadId=thread-1"),
      (error) =>
        error instanceof ApiError &&
        error.status === 409 &&
        error.message === "recovery run requires approval before it can continue"
    );
  } finally {
    restore();
  }
});

test("api client keeps unauthorized clearing behavior while preserving server message", async () => {
  let clearedPath: string | null = null;
  const restore = mockFetch(
    new Response(JSON.stringify({ error: "operator token required" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    })
  );
  try {
    const client = createApiClient({
      getToken: () => "read-token",
      onUnauthorized: (pathname) => {
        clearedPath = pathname;
      },
    });
    await assert.rejects(
      () => client.get("/validation-ops"),
      (error) =>
        error instanceof UnauthorizedError &&
        error.pathname === "/validation-ops" &&
        error.message === "operator token required"
    );
    assert.equal(clearedPath, "/validation-ops");
  } finally {
    restore();
  }
});

test("api client uses short text error bodies before falling back to generic status text", async () => {
  const restore = mockFetch(new Response("plain route failure", { status: 502 }));
  try {
    const client = createApiClient({ getToken: () => null });
    await assert.rejects(
      () => client.get("/bridge/status"),
      (error) => error instanceof ApiError && error.status === 502 && error.message === "plain route failure"
    );
  } finally {
    restore();
  }
});

function mockFetch(response: Response): () => void {
  const previous = globalThis.fetch;
  globalThis.fetch = (async () => response.clone()) as typeof fetch;
  return () => {
    globalThis.fetch = previous;
  };
}
