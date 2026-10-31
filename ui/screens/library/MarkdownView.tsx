// Renders the safe markdown AST (markdown.ts) as React elements: no HTML strings, no <img>, links only
// through callbacks. A long document renders in sections that grow as the reader scrolls, so a 1 MB
// note opens instantly and its DOM stays small until read.
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { inlineText, parseMarkdown, type Block, type Inline, type LinkTarget } from "./markdown.ts";
import { sectionRanges } from "./windowing.ts";

export interface LinkHandlers {
  /** An http(s) or mailto target: the host opens it, never the webview. */
  onOpenExternal?: (url: string) => void;
  /** A relative link to another note in the folder. */
  onOpenNote?: (rel: string) => void;
  /** A fenced code block a screen renders itself (e.g. a diagram). Return `null` to keep the plain code block. */
  renderFence?: (lang: string, text: string) => ReactNode | null;
}

function Inlines({ nodes, h }: { nodes: readonly Inline[]; h: LinkHandlers }): ReactNode {
  return nodes.map((n, i) => {
    switch (n.t) {
      case "text":
        return n.text;
      case "code":
        return <code key={i}>{n.text}</code>;
      case "strong":
        return (
          <strong key={i}>
            <Inlines nodes={n.children} h={h} />
          </strong>
        );
      case "em":
        return (
          <em key={i}>
            <Inlines nodes={n.children} h={h} />
          </em>
        );
      case "del":
        return (
          <del key={i}>
            <Inlines nodes={n.children} h={h} />
          </del>
        );
      case "image":
        // Never loaded: the alt text, then the target as plain text.
        return (
          <span key={i} className="lib-image" title="Images in notes are not loaded">
            [image: {n.alt || "no description"}] <span className="lib-image-src">{n.src}</span>
          </span>
        );
      case "link":
        return <LinkView key={i} target={n.target} h={h} kids={n.children} />;
    }
  });
}

function LinkView({ target, h, kids }: { target: Exclude<LinkTarget, null>; h: LinkHandlers; kids: readonly Inline[] }): ReactNode {
  if (target.kind === "external") {
    if (!h.onOpenExternal) return <Inlines nodes={kids} h={h} />;
    const url = target.url;
    return (
      <a
        href={url}
        rel="noopener noreferrer"
        title={url}
        onClick={(e) => {
          e.preventDefault();
          h.onOpenExternal?.(url);
        }}
      >
        <Inlines nodes={kids} h={h} />
      </a>
    );
  }
  if (!h.onOpenNote) return <Inlines nodes={kids} h={h} />;
  const rel = target.rel;
  return (
    <button type="button" className="lib-link-btn" title={`Open ${rel}`} onClick={() => h.onOpenNote?.(rel)}>
      <Inlines nodes={kids} h={h} />
    </button>
  );
}

const ALIGN = { left: "left", center: "center", right: "right" } as const;

function BlockView({ b, h }: { b: Block; h: LinkHandlers }): ReactNode {
  switch (b.t) {
    case "heading": {
      const Tag = (`h${Math.min(6, b.level + 1)}`) as "h2" | "h3" | "h4" | "h5" | "h6";
      return (
        <Tag id={`md-${b.id}`}>
          <Inlines nodes={b.children} h={h} />
        </Tag>
      );
    }
    case "paragraph":
      return (
        <p>
          <Inlines nodes={b.children} h={h} />
        </p>
      );
    case "hr":
      return <hr />;
    case "code": {
      const custom = h.renderFence?.(b.lang, b.text);
      if (custom) return <>{custom}</>;
      return (
        <figure className="lib-code">
          <figcaption>{b.lang || "text"}</figcaption>
          <pre tabIndex={0}>
            <code>{b.text}</code>
          </pre>
        </figure>
      );
    }
    case "quote":
      return (
        <blockquote>
          {b.children.map((c, i) => (
            <BlockView key={i} b={c} h={h} />
          ))}
        </blockquote>
      );
    case "list": {
      const items = b.items.map((it, i) => (
        <li key={i} className={it.done === null ? undefined : "lib-task"}>
          {it.done !== null && <input type="checkbox" checked={it.done} readOnly disabled aria-label={it.done ? "Done" : "Not done"} />}
          {it.children.map((c, j) => (
            <BlockView key={j} b={c} h={h} />
          ))}
        </li>
      ));
      return b.ordered ? <ol start={b.start}>{items}</ol> : <ul>{items}</ul>;
    }
    case "table":
      return (
        <div className="lib-table-wrap" role="region" aria-label="Table" tabIndex={0}>
          <table>
            <thead>
              <tr>
                {b.head.map((c, i) => (
                  <th key={i} scope="col" style={b.align[i] ? { textAlign: ALIGN[b.align[i]!] } : undefined}>
                    <Inlines nodes={c} h={h} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, i) => (
                <tr key={i}>
                  {r.map((c, j) => (
                    <td key={j} style={b.align[j] ? { textAlign: ALIGN[b.align[j]!] } : undefined}>
                      <Inlines nodes={c} h={h} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

const Section = memo(function Section({ blocks, h }: { blocks: readonly Block[]; h: LinkHandlers }) {
  return (
    <>
      {blocks.map((b, i) => (
        <BlockView key={i} b={b} h={h} />
      ))}
    </>
  );
});

export const SECTION_BLOCKS = 120;

export interface MarkdownViewProps extends LinkHandlers {
  text: string;
  /** The note's own path, so relative links resolve inside the notes folder. */
  baseRel: string | null;
  /** Sections rendered up front (tests render everything with a large number). */
  initialSections?: number;
}

/** Markdown for a note body. Renders `initialSections` sections, then one more whenever the reader nears the end. */
export function MarkdownView({ text, baseRel, onOpenExternal, onOpenNote, renderFence, initialSections = 2 }: MarkdownViewProps): ReactNode {
  const blocks = useMemo(() => parseMarkdown(text, { baseRel }), [text, baseRel]);
  const ranges = useMemo(() => sectionRanges(blocks.length, SECTION_BLOCKS), [blocks.length]);
  const [shown, setShown] = useState(initialSections);
  const sentinel = useRef<HTMLDivElement | null>(null);
  const handlers = useMemo<LinkHandlers>(() => ({ onOpenExternal, onOpenNote, renderFence }), [onOpenExternal, onOpenNote, renderFence]);

  useEffect(() => setShown(initialSections), [text, initialSections]);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || shown >= ranges.length || typeof IntersectionObserver !== "function") return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setShown((n) => Math.min(ranges.length, n + 1));
    }, { rootMargin: "600px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [shown, ranges.length]);

  return (
    <div className="lib-md" aria-label="Note content" role="document">
      {ranges.slice(0, shown).map((r, i) => (
        <Section key={i} blocks={blocks.slice(r.start, r.end)} h={handlers} />
      ))}
      {shown < ranges.length && (
        <div ref={sentinel} className="lib-md-more">
          <button type="button" className="lib-link-btn" onClick={() => setShown((n) => Math.min(ranges.length, n + 1))}>
            Show more ({ranges.length - shown} sections left)
          </button>
        </div>
      )}
    </div>
  );
}

export { inlineText };
