// Minimal markdown for assistant text: paragraphs, ATX headings, bullet and numbered
// lists, fenced code, inline code, bold and italics. Output is React elements only (no
// HTML strings), so streamed model text cannot inject markup. Covers what the chat bubble
// shows; anything else renders as plain text.
import { Fragment, type ReactNode } from "react";

type Block =
  | { kind: "p"; text: string }
  | { kind: "h"; level: number; text: string }
  | { kind: "ul" | "ol"; items: string[] }
  | { kind: "code"; lang: string; text: string };

const FENCE_OPEN = /^```\s*([\w+.-]*)\s*$/;
const FENCE_CLOSE = /^```\s*$/;
const HEADING = /^(#{1,4})\s+(.*)$/;
const BULLET = /^\s*[-*]\s+(.*)$/;
const ORDERED = /^\s*\d+\.\s+(.*)$/;

function isBlockStart(line: string): boolean {
  return FENCE_OPEN.test(line) || HEADING.test(line) || BULLET.test(line) || ORDERED.test(line);
}

/** Splits markdown into blocks. An unclosed fence runs to the end (a stream mid-code). */
export function parseBlocks(src: string): Block[] {
  const lines = src.split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = FENCE_OPEN.exec(line);
    if (fence) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE_CLOSE.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // closing fence (or end of text)
      blocks.push({ kind: "code", lang: fence[1], text: body.join("\n") });
      continue;
    }
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ kind: "h", level: heading[1].length, text: heading[2] });
      i += 1;
      continue;
    }
    if (BULLET.test(line) || ORDERED.test(line)) {
      const ordered = !BULLET.test(line);
      const re = ordered ? ORDERED : BULLET;
      const items: string[] = [];
      while (i < lines.length && re.test(lines[i])) {
        items.push(re.exec(lines[i])?.[1] ?? "");
        i += 1;
      }
      blocks.push({ kind: ordered ? "ol" : "ul", items });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !isBlockStart(lines[i])) {
      para.push(lines[i]);
      i += 1;
    }
    blocks.push({ kind: "p", text: para.join("\n") });
  }
  return blocks;
}

// Inline: `code`, **bold**, *italic*. Unmatched markers stay as literal text.
const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)/g;

export function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const token = m[0];
    if (token.startsWith("`")) {
      out.push(<code key={key++}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("**")) {
      out.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    } else {
      out.push(<em key={key++}>{token.slice(1, -1)}</em>);
    }
    last = at + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Renders markdown text as a list of blocks. */
export function Markdown({ text }: { text: string }) {
  const blocks = parseBlocks(text);
  return (
    <div className="ui-md">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case "p":
            return <p key={i}>{renderInline(b.text)}</p>;
          case "h": {
            const Tag = b.level <= 2 ? "h3" : "h4";
            return <Tag key={i}>{renderInline(b.text)}</Tag>;
          }
          case "ul":
            return (
              <ul key={i}>
                {b.items.map((item, j) => (
                  <li key={j}>{renderInline(item)}</li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={i}>
                {b.items.map((item, j) => (
                  <li key={j}>{renderInline(item)}</li>
                ))}
              </ol>
            );
          case "code":
            return (
              <Fragment key={i}>
                <pre className="ui-md-code" data-lang={b.lang || undefined}>
                  <code>{b.text}</code>
                </pre>
              </Fragment>
            );
        }
      })}
    </div>
  );
}
