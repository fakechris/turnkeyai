import type { BrowserSnapshotResult } from "@turnkeyai/core-types/team";
import type { Page } from "playwright-core";

export async function captureDomSnapshot(input: {
  page: Page;
  requestedUrl: string;
  statusCode: number;
}): Promise<BrowserSnapshotResult> {
  await waitForRenderedBody(input.page);
  const data = (await input.page.evaluate(`(() => {
    function escapeSelector(value) {
      return value.replace(/([ #;?%&,.+*~':"!^$[\\]()=>|/@])/g, "\\\\$1");
    }

    function escapeAttribute(value) {
      return value.replace(/\\\\/g, "\\\\\\\\").replace(/"/g, '\\\\"');
    }

    function buildSelectorCandidates(element) {
      const selectors = [];
      const tagName = element.tagName.toLowerCase();
      const id = element.getAttribute("id");
      if (id) {
        selectors.push("#" + escapeSelector(id));
      }

      const name = element.getAttribute("name");
      if (name) {
        selectors.push(tagName + '[name="' + escapeAttribute(name) + '"]');
      }

      const ariaLabel = element.getAttribute("aria-label");
      if (ariaLabel) {
        selectors.push(tagName + '[aria-label="' + escapeAttribute(ariaLabel) + '"]');
      }

      const placeholder = element.getAttribute("placeholder");
      if (placeholder) {
        selectors.push(tagName + '[placeholder="' + escapeAttribute(placeholder) + '"]');
      }

      if (element.dataset.turnkeyaiRef) {
        selectors.push('[data-turnkeyai-ref="' + escapeAttribute(element.dataset.turnkeyaiRef) + '"]');
      }

      return Array.from(new Set(selectors));
    }

    function visibleTextFrom(root) {
      if (!root) return "";
      if (typeof root.innerText === "string") return root.innerText;
      if (typeof root.textContent === "string") return root.textContent;
      return "";
    }

    const textChunks = [visibleTextFrom(document.body)];
    Array.from(document.querySelectorAll("*")).forEach((element) => {
      if (!element.shadowRoot) return;
      const text = visibleTextFrom(element.shadowRoot);
      if (text) textChunks.push("Shadow root " + (element.id ? "#" + element.id : element.tagName.toLowerCase()) + ": " + text);
    });
    Array.from(document.querySelectorAll("iframe")).forEach((frame) => {
      try {
        const text = visibleTextFrom(frame.contentDocument && frame.contentDocument.body);
        if (text) {
          const label = frame.getAttribute("title") || frame.getAttribute("name") || frame.id || "iframe";
          textChunks.push("Frame " + label + ": " + text);
        }
      } catch {
        // Cross-origin frames are intentionally opaque to the DOM snapshot.
      }
    });

    const textExcerpt = textChunks.join(" ").replace(/\\s+/g, " ").trim().slice(0, 1000);
    document.querySelectorAll("[data-turnkeyai-ref]").forEach((element) => {
      element.removeAttribute("data-turnkeyai-ref");
    });
    const interactives = Array.from(
      document.querySelectorAll("a, button, input, textarea, select, [role='button'], [contenteditable='true']")
    )
      .slice(0, 20)
      .map((element, index) => {
        const html = element;
        const tagName = html.tagName.toLowerCase();
        const role = html.getAttribute("role") || tagName;
        const label = [
          html.innerText,
          html.getAttribute("aria-label"),
          html.getAttribute("placeholder"),
          html.getAttribute("name"),
          html.getAttribute("value"),
        ]
          .find((value) => Boolean(value && value.trim()))
          ?.trim();
        const refId = "ref-" + String(index + 1);
        html.setAttribute("data-turnkeyai-ref", refId);
        const selectors = buildSelectorCandidates(html);
        const textAnchors = [label, html.textContent, html.getAttribute("aria-label")]
          .map((value) => value && value.trim())
          .filter((value) => Boolean(value))
          .slice(0, 3);

        return {
          refId,
          tagName,
          role,
          label: label || "(unlabeled)",
          selectors,
          textAnchors,
        };
      });

    return {
      finalUrl: window.location.href,
      title: document.title || window.location.href,
      textExcerpt,
      interactives,
    };
  })()`)) as {
    finalUrl: string;
    title: string;
    textExcerpt: string;
    interactives: BrowserSnapshotResult["interactives"];
  };

  return {
    requestedUrl: input.requestedUrl,
    finalUrl: data.finalUrl,
    title: data.title,
    textExcerpt: data.textExcerpt,
    statusCode: input.statusCode,
    interactives: data.interactives,
  };
}

async function waitForRenderedBody(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => {});
  await page
    .waitForFunction(
      `(() => {
        const text = document.body ? document.body.innerText.replace(/\\s+/g, " ").trim() : "";
        return Boolean(text) && !/^Loading\\b/i.test(text);
      })()`,
      undefined,
      { timeout: 2_000 }
    )
    .catch(() => {});
}
