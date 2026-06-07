import assert from "node:assert/strict";
import test from "node:test";

import type { Page } from "playwright-core";

import { captureDomSnapshot } from "./dom-snapshot";

test("captureDomSnapshot waits briefly for Loading placeholder to render", async () => {
  const calls: Array<{ name: string; timeout?: number }> = [];
  let evaluateExpression = "";
  const recordCall = (name: string, timeout?: number) => {
    calls.push(timeout === undefined ? { name } : { name, timeout });
  };
  const page = {
    async waitForLoadState(_state: string, options?: { timeout?: number }) {
      recordCall("waitForLoadState", options?.timeout);
    },
    async waitForFunction(_expression: string, _arg?: unknown, options?: { timeout?: number }) {
      recordCall("waitForFunction", options?.timeout);
    },
    async evaluate(expression: string) {
      recordCall("evaluate");
      evaluateExpression = expression;
      return {
        finalUrl: "http://127.0.0.1/product-signals",
        title: "Workbench Product Signals",
        textExcerpt: "Workbench product signals Stuck missions: 6 Weak answer rate: 24%",
        interactives: [],
      };
    },
  } as unknown as Page;

  const snapshot = await captureDomSnapshot({
    page,
    requestedUrl: "http://127.0.0.1/product-signals",
    statusCode: 200,
  });

  assert.deepEqual(
    calls.map((call) => call.name),
    ["waitForLoadState", "waitForFunction", "evaluate"]
  );
  assert.equal(calls[1]?.timeout, 2_000);
  assert.match(evaluateExpression, /shadowRoot/);
  assert.match(evaluateExpression, /textContent/);
  assert.match(evaluateExpression, /querySelectorAll\("iframe"\)/);
  assert.match(snapshot.textExcerpt, /Stuck missions: 6/);
  assert.match(snapshot.textExcerpt, /Weak answer rate: 24%/);
});
