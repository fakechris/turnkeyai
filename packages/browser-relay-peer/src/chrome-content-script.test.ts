import assert from "node:assert/strict";
import test from "node:test";

import { executeChromeRelayContentScriptActions } from "./chrome-content-script";

test("chrome content script executes snapshot, click, type, scroll, wait, and console actions against a document-like environment", async () => {
  let clicked = false;
  let dispatched = 0;
  let scrollTop = 0;
  const button = createElement("button", "Approve", {
    click() {
      clicked = true;
    },
  });
  const input = createElement("input", "", {
    value: "",
    dispatchEvent() {
      dispatched += 1;
    },
  });
  const environment = {
    window: {
      location: {
        href: "https://example.com/workflow",
      },
      scrollY: 0,
      scrollBy({ top }: { top: number }) {
        scrollTop += top;
        this.scrollY = scrollTop;
      },
    },
    document: createDocument([button, input], "Workflow"),
  };

  const response = await executeChromeRelayContentScriptActions(environment, [
    { kind: "snapshot", note: "before" },
    { kind: "click", text: "Approve" },
    { kind: "type", selectors: ["input"], text: "hello", submit: true },
    { kind: "scroll", direction: "down", amount: 240 },
    { kind: "wait", timeoutMs: 1 },
    { kind: "console", probe: "page-metadata" },
  ]);

  assert.equal(response.ok, true);
  assert.equal(response.page?.finalUrl, "https://example.com/workflow");
  assert.equal(response.trace.length, 6);
  assert.equal(clicked, true);
  assert.equal(input.value, "hello");
  assert.equal(dispatched >= 2, true);
  assert.equal(scrollTop, 240);
  assert.equal(response.trace[4]?.kind, "wait");
  assert.equal(response.trace[5]?.kind, "console");
});

test("chrome content script returns a failed response when the target element cannot be resolved", async () => {
  const response = await executeChromeRelayContentScriptActions(
    {
      window: { location: { href: "https://example.com" } },
      document: createDocument([], "Empty"),
    },
    [{ kind: "click", text: "Missing" }]
  );

  assert.equal(response.ok, false);
  assert.match(response.errorMessage ?? "", /could not resolve target element/);
});

test("chrome content script accepts array-like DOM collections returned by querySelectorAll", async () => {
  const button = createElement("button", "Approve");
  const response = await executeChromeRelayContentScriptActions(
    {
      window: { location: { href: "https://example.com" } },
      document: {
        title: "ArrayLike",
        querySelectorAll() {
          return {
            0: button,
            length: 1,
            [Symbol.iterator]: Array.prototype[Symbol.iterator],
          };
        },
      },
    },
    [{ kind: "snapshot", note: "array-like" }]
  );

  assert.equal(response.ok, true);
  assert.equal(response.page?.interactives.length, 1);
  assert.equal(response.page?.interactives[0]?.label, "Approve");
});

function createDocument(elements: ReturnType<typeof createElement>[], title: string) {
  return {
    title,
    querySelectorAll(selector: string) {
      if (selector === "a,button,input,textarea,select,[role='button'],[contenteditable='true']") {
        return elements;
      }
      if (selector === "input") {
        return elements.filter((element) => element.tagName === "INPUT");
      }
      const refMatch = /^\[data-turnkeyai-ref="(.+)"\]$/.exec(selector);
      if (refMatch) {
        return elements.filter((element) => element.dataset.turnkeyaiRef === refMatch[1]);
      }
      return [];
    },
  };
}

function createElement(
  tagName: string,
  text: string,
  overrides: Partial<{
    value: string;
    click(): void;
    focus(): void;
    dispatchEvent(event: unknown): void;
  }> = {}
) {
  const attributes = new Map<string, string>();
  const element = {
    tagName: tagName.toUpperCase(),
    innerText: text,
    textContent: text,
    value: overrides.value ?? "",
    dataset: {} as Record<string, string | undefined>,
    getAttribute(name: string) {
      return attributes.get(name) ?? null;
    },
    setAttribute(name: string, value: string) {
      attributes.set(name, value);
    },
    click: overrides.click ?? (() => undefined),
    focus: overrides.focus ?? (() => undefined),
    dispatchEvent: overrides.dispatchEvent ?? (() => undefined),
  };
  return element;
}
