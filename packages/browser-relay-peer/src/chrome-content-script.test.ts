import assert from "node:assert/strict";
import test from "node:test";

import { executeChromeRelayContentScriptActions } from "./chrome-content-script";

test("chrome content script executes snapshot, click, type, select, waitFor, storage, scroll, wait, and console actions against a document-like environment", async () => {
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
  const select = createElement("select", "Plan", {
    value: "",
    selectedIndex: -1,
    options: [
      { value: "basic", label: "Basic" },
      { value: "team", label: "Team" },
    ],
    dispatchEvent() {
      dispatched += 1;
    },
  });
  const environment = {
    window: {
      location: {
        href: "https://example.com/workflow",
      },
      localStorage: createStorage(),
      scrollY: 0,
      scrollBy({ top }: { top: number }) {
        scrollTop += top;
        this.scrollY = scrollTop;
      },
    },
    document: createDocument([button, input, select], "Workflow"),
  };

  const response = await executeChromeRelayContentScriptActions(environment, [
    { kind: "snapshot", note: "before" },
    { kind: "click", text: "Approve" },
    { kind: "type", selectors: ["input"], text: "hello", submit: true },
    { kind: "select", selectors: ["select"], label: "Team" },
    { kind: "waitFor", text: "Approve", timeoutMs: 0 },
    { kind: "storage", area: "localStorage", action: "set", key: "token", value: "abc" },
    { kind: "storage", area: "localStorage", action: "get", key: "token" },
    { kind: "scroll", direction: "down", amount: 240 },
    { kind: "wait", timeoutMs: 0 },
    { kind: "console", probe: "page-metadata" },
  ]);

  assert.equal(response.ok, true);
  assert.equal(response.page?.finalUrl, "https://example.com/workflow");
  assert.equal(response.trace.length, 10);
  assert.equal(clicked, true);
  assert.equal(input.value, "hello");
  assert.equal(select.value, "team");
  assert.equal(select.selectedIndex, 1);
  assert.equal(dispatched >= 2, true);
  assert.equal(scrollTop, 240);
  assert.equal(response.trace[4]?.kind, "waitFor");
  assert.equal(response.trace[5]?.kind, "storage");
  assert.equal(response.trace[6]?.output?.value, "abc");
  assert.equal(response.trace[8]?.kind, "wait");
  assert.equal(response.trace[9]?.kind, "console");
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
      if (selector === "select") {
        return elements.filter((element) => element.tagName === "SELECT");
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
    selectedIndex: number;
    options: Array<{ value?: string; label?: string; text?: string; selected?: boolean }>;
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
    ...(overrides.selectedIndex !== undefined ? { selectedIndex: overrides.selectedIndex } : {}),
    ...(overrides.options !== undefined ? { options: overrides.options } : {}),
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

function createStorage() {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    key(index: number) {
      return [...values.keys()][index] ?? null;
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    removeItem(key: string) {
      values.delete(key);
    },
    clear() {
      values.clear();
    },
  };
}
