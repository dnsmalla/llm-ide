// Renders the markdown AST (markdown.ts) as React elements. No HTML strings, no <img>.
// Links call `onOpenLink` (the host opener) and never navigate the webview.
import { memo, useCallback, useState, type ReactNode } from "react";
import { parseBlocks, type Block, type Inline } from "./markdown";

export interface MarkdownProps {
  text: string;
  /** Called with an allowlisted URL; the host opens it. Omit to render links as inert text. */
  onOpenLink?: (href: string) => void;
  /** Copies text (host clipboard). Omit to hide the copy button. */
  onCopy?: (text: string) => void;
}

function Inlines({ nodes, onOpenLink }: { nodes: Inline[]; onOpenLink?: (href: string) => void }): ReactNode {
  return nodes.map((n, i) => {
    switch (n.kind) {
      case "text": return n.text;
      case "code": return <code key={i}>{n.text}</code>;
      case "strong": return <strong key={i}><Inlines nodes={n.children} onOpenLink={onOpenLink} /></strong>;
      case "em": return <em key={i}><Inlines nodes={n.children} onOpenLink={onOpenLink} /></em>;
      case "link":
        return onOpenLink ? (
          <a key={i} href={n.href} rel="noopener noreferrer" title={n.href}
            onClick={(e) => { e.preventDefault(); onOpenLink(n.href); }}>
            <Inlines nodes={n.children} onOpenLink={onOpenLink} />
          </a>
        ) : <span key={i}><Inlines nodes={n.children} /></span>;
    }
  });
}

function CodeBlock({ lang, text, onCopy }: { lang: string; text: string; onCopy?: (t: string) => void }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    onCopy?.(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [onCopy, text]);
  return (
    <figure className="chat-code">
      <figcaption className="chat-code-head">
        <span>{lang || "text"}</span>
        {onCopy && <button type="button" className="chat-link-btn" onClick={copy} aria-label="Copy code">{copied ? "Copied" : "Copy"}</button>}
      </figcaption>
      <pre tabIndex={0}><code>{text}</code></pre>
    </figure>
  );
}

function BlockView({ b, onOpenLink, onCopy }: { b: Block } & Omit<MarkdownProps, "text">) {
  switch (b.kind) {
    case "p": return <p><Inlines nodes={b.inlines} onOpenLink={onOpenLink} /></p>;
    case "h": { const Tag = b.level <= 2 ? "h3" : "h4"; return <Tag><Inlines nodes={b.inlines} onOpenLink={onOpenLink} /></Tag>; }
    case "ul": return <ul>{b.items.map((it, j) => <li key={j}><Inlines nodes={it} onOpenLink={onOpenLink} /></li>)}</ul>;
    case "ol": return <ol>{b.items.map((it, j) => <li key={j}><Inlines nodes={it} onOpenLink={onOpenLink} /></li>)}</ol>;
    case "quote": return <blockquote><Inlines nodes={b.inlines} onOpenLink={onOpenLink} /></blockquote>;
    case "hr": return <hr />;
    case "code": return <CodeBlock lang={b.lang} text={b.text} onCopy={onCopy} />;
    case "table":
      return (
        <div className="chat-table-wrap" role="region" aria-label="Table" tabIndex={0}>
          <table>
            <thead><tr>{b.head.map((c, j) => <th key={j} scope="col"><Inlines nodes={c} onOpenLink={onOpenLink} /></th>)}</tr></thead>
            <tbody>{b.rows.map((r, j) => <tr key={j}>{r.map((c, k) => <td key={k}><Inlines nodes={c} onOpenLink={onOpenLink} /></td>)}</tr>)}</tbody>
          </table>
        </div>
      );
  }
}

/** One markdown chunk. Memoised on its text: a sealed block never re-renders while a stream continues. */
export const Markdown = memo(function Markdown({ text, onOpenLink, onCopy }: MarkdownProps) {
  const blocks = parseBlocks(text);
  return (
    <div className="chat-md">
      {blocks.map((b, i) => <BlockView key={i} b={b} onOpenLink={onOpenLink} onCopy={onCopy} />)}
    </div>
  );
});
