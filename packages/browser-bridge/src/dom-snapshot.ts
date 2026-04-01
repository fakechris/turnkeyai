import type { BrowserSnapshotResult } from "@turnkeyai/core-types/team";
import type { Page } from "playwright-core";

export async function captureDomSnapshot(input: {
  page: Page;
  requestedUrl: string;
  statusCode: number;
}): Promise<BrowserSnapshotResult> {
  const data = await input.page.evaluate(() => {
    function escapeSelector(value: string): string {
      return value.replace(/([ #;?%&,.+*~':"!^$[\]()=>|/@])/g, "\\$1");
    }

    function escapeAttribute(value: string): string {
      return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    }

    function buildSelectorCandidates(element: HTMLElement): string[] {
      const selectors: string[] = [];
      const tagName = element.tagName.toLowerCase();
      const id = element.getAttribute("id");
      if (id) {
        selectors.push(`#${escapeSelector(id)}`);
      }

      const name = element.getAttribute("name");
      if (name) {
        selectors.push(`${tagName}[name="${escapeAttribute(name)}"]`);
      }

      const ariaLabel = element.getAttribute("aria-label");
      if (ariaLabel) {
        selectors.push(`${tagName}[aria-label="${escapeAttribute(ariaLabel)}"]`);
      }

      const placeholder = element.getAttribute("placeholder");
      if (placeholder) {
        selectors.push(`${tagName}[placeholder="${escapeAttribute(placeholder)}"]`);
      }

      if (element.dataset.turnkeyaiRef) {
        selectors.push(`[data-turnkeyai-ref="${escapeAttribute(element.dataset.turnkeyaiRef)}"]`);
      }

      return [...new Set(selectors)];
    }

    const bodyText = document.body?.innerText ?? "";
    const textExcerpt = bodyText.replace(/\s+/g, " ").trim().slice(0, 600);
    document.querySelectorAll("[data-turnkeyai-ref]").forEach((element) => {
      element.removeAttribute("data-turnkeyai-ref");
    });
    const interactives = Array.from(
      document.querySelectorAll("a, button, input, textarea, select, [role='button'], [contenteditable='true']")
    )
      .slice(0, 20)
      .map((element, index) => {
        const html = element as HTMLElement;
        const tagName = html.tagName.toLowerCase();
        const role = html.getAttribute("role") ?? tagName;
        const label = [
          html.innerText,
          html.getAttribute("aria-label"),
          html.getAttribute("placeholder"),
          html.getAttribute("name"),
          html.getAttribute("value"),
        ]
          .find((value) => Boolean(value?.trim()))
          ?.trim();
        const refId = `ref-${index + 1}`;
        html.setAttribute("data-turnkeyai-ref", refId);
        const selectors = buildSelectorCandidates(html);
        const textAnchors = [label, html.textContent, html.getAttribute("aria-label")]
          .map((value) => value?.trim())
          .filter((value): value is string => Boolean(value))
          .slice(0, 3);

        return {
          refId,
          tagName,
          role,
          label: label ?? "(unlabeled)",
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
  });

  return {
    requestedUrl: input.requestedUrl,
    finalUrl: data.finalUrl,
    title: data.title,
    textExcerpt: data.textExcerpt,
    statusCode: input.statusCode,
    interactives: data.interactives,
  };
}
