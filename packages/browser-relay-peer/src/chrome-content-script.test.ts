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
    { kind: "waitFor", titlePattern: "Workflow", timeoutMs: 0 },
    { kind: "storage", area: "localStorage", action: "set", key: "token", value: "abc" },
    { kind: "storage", area: "localStorage", action: "get", key: "token" },
    { kind: "scroll", direction: "down", amount: 240 },
    { kind: "wait", timeoutMs: 0 },
    { kind: "console", probe: "page-metadata" },
    { kind: "probe", probe: "forms", maxItems: 2 },
  ]);

  assert.equal(response.ok, true);
  assert.equal(response.page?.finalUrl, "https://example.com/workflow");
  assert.equal(response.trace.length, 12);
  assert.equal(clicked, true);
  assert.equal(input.value, "hello");
  assert.equal(select.value, "team");
  assert.equal(select.selectedIndex, 1);
  assert.equal(dispatched >= 2, true);
  assert.equal(scrollTop, 240);
  assert.equal(response.trace[4]?.kind, "waitFor");
  assert.equal(response.trace[5]?.kind, "waitFor");
  assert.equal(response.trace[5]?.output?.titlePattern, "Workflow");
  assert.equal(response.trace[6]?.kind, "storage");
  assert.equal(response.trace[7]?.output?.value, "abc");
  assert.equal(response.trace[9]?.kind, "wait");
  assert.equal(response.trace[10]?.kind, "console");
  assert.equal(response.trace[11]?.kind, "probe");
  assert.equal(Array.isArray(response.trace[11]?.output?.result), true);
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

test("chrome content script uploads injected file payloads to file inputs", async () => {
  let dispatched = 0;
  const input = createElement("input", "", {
    dispatchEvent() {
      dispatched += 1;
    },
  }) as ReturnType<typeof createElement> & { files?: Array<{ name: string; size: number; type: string }> };
  class TestFile {
    readonly size: number;
    readonly type: string;

    constructor(
      readonly parts: unknown[],
      readonly name: string,
      options?: { type?: string }
    ) {
      this.type = options?.type ?? "";
      this.size = parts.reduce<number>((total, part) => {
        return total + (part instanceof Uint8Array ? part.byteLength : 0);
      }, 0);
    }
  }
  class TestDataTransfer {
    readonly files: TestFile[] = [];
    readonly items = {
      add: (file: unknown) => {
        this.files.push(file as TestFile);
      },
    };
  }

  const response = await executeChromeRelayContentScriptActions(
    {
      window: {
        location: { href: "https://example.com/upload" },
        File: TestFile,
        DataTransfer: TestDataTransfer,
        atob(value: string) {
          return Buffer.from(value, "base64").toString("binary");
        },
      },
      document: createDocument([input], "Upload"),
    },
    [
      {
        kind: "upload",
        selectors: ["input"],
        artifactId: "artifact-upload",
        file: {
          name: "fixture.txt",
          mimeType: "text/plain",
          dataBase64: "aGVsbG8=",
          sizeBytes: 5,
        },
      },
    ]
  );

  assert.equal(response.ok, true);
  assert.equal(dispatched, 2);
  assert.equal(input.files?.[0]?.name, "fixture.txt");
  assert.equal(input.files?.[0]?.size, 5);
  assert.equal(input.files?.[0]?.type, "text/plain");
  assert.equal(response.trace[0]?.kind, "upload");
  assert.equal(response.trace[0]?.output?.fileName, "fixture.txt");
});

test("chrome content script rejects upload payload size mismatches", async () => {
  const input = createElement("input", "", {});

  const response = await executeChromeRelayContentScriptActions(
    {
      window: {
        location: { href: "https://example.com/upload" },
        File: class TestFile {
          constructor() {}
        },
        DataTransfer: class TestDataTransfer {
          readonly files: unknown[] = [];
          readonly items = {
            add: (file: unknown) => {
              this.files.push(file);
            },
          };
        },
        atob(value: string) {
          return Buffer.from(value, "base64").toString("binary");
        },
      },
      document: createDocument([input], "Upload"),
    },
    [
      {
        kind: "upload",
        selectors: ["input"],
        artifactId: "artifact-upload",
        file: {
          name: "fixture.txt",
          dataBase64: "aGVsbG8=",
          sizeBytes: 6,
        },
      },
    ]
  );

  assert.equal(response.ok, false);
  assert.match(response.errorMessage ?? "", /upload payload size does not match decoded bytes/);
});

function createDocument(elements: ReturnType<typeof createElement>[], title: string) {
  return {
    title,
    querySelectorAll(selector: string) {
      if (selector === "a,button,input,textarea,select,[role='button'],[contenteditable='true']") {
        return elements;
      }
      if (selector === "input,textarea,select,button") {
        return elements.filter((element) => ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(element.tagName));
      }
      if (selector === "a,button,[role='button']") {
        return elements.filter((element) => element.tagName === "A" || element.tagName === "BUTTON" || element.getAttribute("role") === "button");
      }
      if (selector === "a[download]") {
        return elements.filter((element) => element.tagName === "A" && Boolean(element.download || element.getAttribute("download")));
      }
      if (
        selector ===
        "a[download],a[href$='.csv'],a[href$='.pdf'],a[href$='.zip'],a[href$='.xlsx'],a[href$='.json']"
      ) {
        return elements.filter(
          (element) =>
            element.tagName === "A" &&
            (Boolean(element.download || element.getAttribute("download")) ||
              /\.(csv|pdf|zip|xlsx|json)$/i.test(element.href ?? element.getAttribute("href") ?? ""))
        );
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
    id: string;
    name: string;
    type: string;
    placeholder: string;
    href: string;
    target: string;
    download: string;
    checked: boolean;
    disabled: boolean;
    required: boolean;
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
    id: overrides.id ?? "",
    name: overrides.name ?? "",
    type: overrides.type ?? "",
    placeholder: overrides.placeholder ?? "",
    href: overrides.href ?? "",
    target: overrides.target ?? "",
    download: overrides.download ?? "",
    innerText: text,
    textContent: text,
    value: overrides.value ?? "",
    checked: Boolean(overrides.checked),
    disabled: Boolean(overrides.disabled),
    required: Boolean(overrides.required),
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
