import type { ReactNode } from "react";

interface MarkdownProps {
  text: string;
  className?: string;
}

type Block =
  | { kind: "heading"; level: 2 | 3; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "quote"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "code"; text: string }
  | { kind: "table"; headers: string[]; rows: string[][] };

export function Markdown({ text, className }: MarkdownProps) {
  return (
    <div className={["markdown-body", className].filter(Boolean).join(" ")}>
      {parseBlocks(text).map((block, index) => renderBlock(block, index))}
    </div>
  );
}

function renderBlock(block: Block, index: number): ReactNode {
  switch (block.kind) {
    case "heading": {
      const content = renderInline(block.text);
      return block.level === 2 ? (
        <h2 key={index}>{content}</h2>
      ) : (
        <h3 key={index}>{content}</h3>
      );
    }
    case "paragraph":
      return <p key={index}>{renderInline(block.text)}</p>;
    case "quote":
      return <blockquote key={index}>{renderInline(block.text)}</blockquote>;
    case "list": {
      const Tag = block.ordered ? "ol" : "ul";
      return (
        <Tag key={index}>
          {block.items.map((item, itemIndex) => (
            <li key={itemIndex}>{renderInline(item)}</li>
          ))}
        </Tag>
      );
    }
    case "code":
      return (
        <pre key={index}>
          <code>{block.text}</code>
        </pre>
      );
    case "table":
      return (
        <div key={index} className="markdown-table-wrap">
          <table>
            <thead>
              <tr>
                {block.headers.map((header, cellIndex) => (
                  <th key={cellIndex}>{renderInline(header)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {block.headers.map((_, cellIndex) => (
                    <td key={cellIndex}>{renderInline(row[cellIndex] ?? "")}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim().length === 0) {
      i += 1;
      continue;
    }

    const openingFence = /^(`{3,})/.exec(line.trim());
    if (openingFence) {
      const fenceLength = openingFence[1]!.length;
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !isClosingFence(lines[i] ?? "", fenceLength)) {
        codeLines.push(lines[i] ?? "");
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push({ kind: "code", text: codeLines.join("\n") });
      continue;
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(line.trim());
    if (heading) {
      blocks.push({
        kind: "heading",
        level: heading[1]!.length <= 2 ? 2 : 3,
        text: heading[2]!,
      });
      i += 1;
      continue;
    }

    if (isTableStart(lines, i)) {
      const headers = splitTableRow(lines[i] ?? "");
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] ?? "").includes("|") && (lines[i] ?? "").trim().length > 0) {
        rows.push(splitTableRow(lines[i] ?? ""));
        i += 1;
      }
      blocks.push({ kind: "table", headers, rows });
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i] ?? "")) {
        quoteLines.push((lines[i] ?? "").replace(/^\s*>\s?/, ""));
        i += 1;
      }
      blocks.push({ kind: "quote", text: quoteLines.join(" ") });
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^\s*[-*]\s+/, ""));
        i += 1;
      }
      blocks.push({ kind: "list", ordered: false, items });
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^\s*\d+[.)]\s+/, ""));
        i += 1;
      }
      blocks.push({ kind: "list", ordered: true, items });
      continue;
    }

    const paragraphLines: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? "").trim().length > 0 &&
      !startsBlock(lines, i)
    ) {
      paragraphLines.push(lines[i] ?? "");
      i += 1;
    }
    blocks.push({ kind: "paragraph", text: paragraphLines.join(" ") });
  }

  return blocks;
}

function startsBlock(lines: string[], index: number): boolean {
  const line = lines[index] ?? "";
  return (
    /^`{3,}/.test(line.trim()) ||
    /^(#{1,3})\s+/.test(line.trim()) ||
    /^\s*>\s?/.test(line) ||
    /^\s*[-*]\s+/.test(line) ||
    /^\s*\d+[.)]\s+/.test(line) ||
    isTableStart(lines, index)
  );
}

function isTableStart(lines: string[], index: number): boolean {
  const current = lines[index] ?? "";
  const next = lines[index + 1] ?? "";
  return current.includes("|") && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(next);
}

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let index = 0;
  let plainStart = 0;
  const flushPlain = (end: number) => {
    if (end > plainStart) {
      nodes.push(text.slice(plainStart, end));
    }
  };
  while (index < text.length) {
    if (text.startsWith("**", index)) {
      const close = text.indexOf("**", index + 2);
      if (close > index + 2) {
        flushPlain(index);
        nodes.push(<strong key={`${index}-strong`}>{renderInline(text.slice(index + 2, close))}</strong>);
        index = close + 2;
        plainStart = index;
        continue;
      }
    }
    if (text[index] === "`") {
      const close = text.indexOf("`", index + 1);
      if (close > index + 1) {
        flushPlain(index);
        nodes.push(<code key={`${index}-code`}>{text.slice(index + 1, close)}</code>);
        index = close + 1;
        plainStart = index;
        continue;
      }
    }
    const link = parseInlineLink(text, index);
    if (link) {
      flushPlain(index);
      nodes.push(
        <a key={`${index}-link`} href={link.href} target="_blank" rel="noreferrer">
          {link.label}
        </a>
      );
      index = link.end;
      plainStart = index;
      continue;
    }
    index += 1;
  }
  flushPlain(text.length);
  return nodes;
}

function isClosingFence(line: string, openingFenceLength: number): boolean {
  const trimmed = line.trim();
  return /^`+$/.test(trimmed) && trimmed.length >= openingFenceLength;
}

function parseInlineLink(text: string, index: number): { label: string; href: string; end: number } | null {
  if (text[index] !== "[") {
    return null;
  }
  const labelEnd = text.indexOf("](", index + 1);
  if (labelEnd <= index + 1) {
    return null;
  }
  const hrefStart = labelEnd + 2;
  let depth = 0;
  for (let i = hrefStart; i < text.length; i += 1) {
    const char = text[i];
    if (char === "\\") {
      i += 1;
      continue;
    }
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      if (depth > 0) {
        depth -= 1;
        continue;
      }
      const href = text.slice(hrefStart, i);
      if (!/^https?:\/\//.test(href)) {
        return null;
      }
      return {
        label: text.slice(index + 1, labelEnd),
        href,
        end: i + 1,
      };
    }
  }
  return null;
}
