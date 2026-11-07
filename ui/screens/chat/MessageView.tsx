// One message: user bubble or assistant parts (streamed text, tool cards, notices). Memoised so a stream
// only re-renders the last message; inside it only the open tail of the text re-parses.
import { editPreviewFor } from "./plan/EditPreview";
import { memo, useState } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import { Markdown } from "./MarkdownView";
import { ModeBadge } from "./badges/Badges";
import { textOf, type AssistantMessage, type Message, type Notice, type TextPart, type ToolPart } from "./state";
import { billableTokens, compactTokenCount, usageTooltip } from "./usage";

export interface FileRefs {
  /** Project-relative path for a path found in a tool's arguments, or null when it is not inside the open project. */
  resolve(raw: string): string | null;
  open(rel: string): void;
}

export interface MessageHost {
  onOpenLink?: (href: string) => void;
  onCopy?: (text: string) => void;
  /** "Open in Explorer" for tool calls that name a file. */
  files?: FileRefs;
  /** Retry the failed turn from the message itself. */
  onRetry?: () => void;
  /** On a "continued from a summary" notice: send the full history with the next message (one message). */
  onFullHistoryNext?: () => void;
}

const PATH_KEYS = ["file_path", "path", "filePath", "notebook_path"] as const;

/** The file a tool call names (`file_path`/`path` argument), from the raw args JSON. Never throws; capped. */
export function fileArgOf(args: string): string | null {
  if (!args || args.length > 20_000) return null;
  try {
    const o: unknown = JSON.parse(args);
    if (o && typeof o === "object" && !Array.isArray(o)) {
      for (const k of PATH_KEYS) {
        const v = (o as Record<string, unknown>)[k];
        if (typeof v === "string" && v.length > 0 && v.length <= 4096 && !v.includes("\0")) return v;
      }
    }
  } catch {
    // partial or non-JSON arguments while streaming
  }
  return null;
}

/** Characters of a tool output shown before "Show more"; each step reveals this much more. */
export const TOOL_PREVIEW_CHARS = 1_500;
export const TOOL_ARGS_PREVIEW_CHARS = 600;

export function clipPreview(text: string, shown: number): { text: string; rest: number } {
  return text.length <= shown ? { text, rest: 0 } : { text: text.slice(0, shown), rest: text.length - shown };
}

/** Characters of one message rendered before "Show more"; each click reveals this much more. */
export const RENDER_CAP_CHARS = 1_000_000;

/** The blocks to render within `limit` characters (a block crossing the limit is cut at a line end) and what is left. */
export function windowBlocks(blocks: readonly string[], limit: number): { blocks: string[]; hidden: number } {
  const out: string[] = [];
  let used = 0, total = 0;
  for (const b of blocks) total += b.length;
  for (const b of blocks) {
    if (used + b.length <= limit) { out.push(b); used += b.length; continue; }
    const room = limit - used;
    if (room > 0) {
      const cut = b.lastIndexOf("\n", room - 1);
      const keep = cut > 0 ? cut + 1 : room;
      out.push(b.slice(0, keep)); used += keep;
    }
    break;
  }
  return { blocks: out, hidden: total - used };
}

function StreamingText({ part, host, live }: { part: TextPart; host: MessageHost; live: boolean }) {
  const [limit, setLimit] = useState(RENDER_CAP_CHARS);
  const all = part.open + part.line ? [...part.sealed, part.open + part.line] : part.sealed;
  const w = windowBlocks(all, limit);
  // Blocks are keyed by index: sealed ones never change, so memoised Markdown skips them while the stream continues.
  return (
    <>
      {w.blocks.map((block, i) => <Markdown key={i} text={block} onOpenLink={host.onOpenLink} onCopy={host.onCopy} />)}
      {w.hidden > 0 && (
        <button type="button" className="chat-link-btn" onClick={() => setLimit(limit + RENDER_CAP_CHARS)}>
          Show more ({w.hidden.toLocaleString("en-US")} characters not shown)
        </button>
      )}
      {live && w.hidden === 0 && <span className="chat-caret" aria-hidden="true" />}
    </>
  );
}

function prettyArgs(args: string): string {
  try { return JSON.stringify(JSON.parse(args), null, 2); } catch { return args; }
}

export function ToolCard({ tool, files }: { tool: ToolPart; files?: FileRefs }) {
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(TOOL_PREVIEW_CHARS);
  const state = tool.result === null ? "running" : tool.result.isError ? "failed" : "done";
  const bodyId = `tool-${tool.id || tool.index}`;
  const res = tool.result ? clipPreview(tool.result.text, shown) : null;
  const fileRaw = files && !tool.argsTruncated ? fileArgOf(tool.args) : null;
  const fileRel = fileRaw !== null && files ? files.resolve(fileRaw) : null;
  const args = clipPreview(prettyArgs(tool.args), TOOL_ARGS_PREVIEW_CHARS * (shown / TOOL_PREVIEW_CHARS));
  return (
    <div className="chat-tool" data-state={state}>
      <button type="button" className="chat-tool-head" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(!open)}>
        <span className="chat-tool-name">{tool.name}</span>
        <span className="chat-tool-state">{state}</span>
      </button>
      {open && (
        <div id={bodyId} className="chat-tool-body">
          {fileRel !== null && files && (
            <button type="button" className="chat-link-btn" onClick={() => files.open(fileRel)}>Open in Explorer</button>
          )}
          {editPreviewFor(tool, files?.resolve)}
          {tool.args && <pre className="chat-tool-args" aria-label="Arguments">{args.text}{args.rest > 0 ? "\n…" : ""}</pre>}
          {res && <pre className="chat-tool-out" aria-label="Output">{res.text}{res.rest > 0 ? "\n…" : ""}</pre>}
          {res && res.rest > 0 && (
            <button type="button" className="chat-link-btn" onClick={() => setShown(shown + TOOL_PREVIEW_CHARS * 4)}>
              Show more ({res.rest.toLocaleString("en-US")} characters left)
            </button>
          )}
          {tool.result?.truncated && <p className="chat-muted">Output was shortened by the core.</p>}
          {tool.argsTruncated && <p className="chat-muted">Arguments were shortened.</p>}
        </div>
      )}
    </div>
  );
}

function NoticeLine({ n, host }: { n: Notice; host: MessageHost }) {
  const text = n.count > 1 ? `${n.text} (x${n.count})` : n.text;
  const message = n.kind === "chat_continued" && host.onFullHistoryNext
    ? <>{text} <button type="button" className="chat-link-btn" onClick={host.onFullHistoryNext}>Send the full history with my next message</button></>
    : text;
  return <StatusBanner severity={n.level === "error" ? "error" : n.level === "warning" ? "warning" : "info"} message={message} />;
}

/** The Mac's collapsed-reply preview (MarkdownRenderer.plainTextPreview): links to text, structural marks dropped,
 *  whitespace collapsed, at most 160 characters. Plain text only; React escapes it. */
export function replyPreview(markdown: string, limit = 160): string {
  const s = markdown
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`#*_>~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > limit ? `${s.slice(0, limit)}\u2026` : s;
}

function Assistant({ m, host, collapsed, collapsible, onToggle }: { m: AssistantMessage; host: MessageHost } & CollapseProps) {
  const live = m.status === "streaming";
  const lastIdx = m.parts.length - 1;
  const text = m.parts.map((p) => (p.kind === "text" ? textOf(p) : "")).join("").trim();
  // The Mac folds only the reply text: tool steps, notices and the stopped/failed status stay visible, and a reply
  // with no text (or one still streaming) is never folded.
  const fold = collapsed === true && !live && text !== "";
  return (
    <article className="chat-msg chat-assistant" aria-label={fold ? "Assistant message (collapsed)" : "Assistant message"} aria-busy={live}>
      <span className="chat-role">llm-agent</span>
      {m.mode ? <ModeBadge mode={m.mode} resolved={null} /> : null}
      {host.onCopy && text && !live ? <button type="button" className="chat-copy" onClick={() => host.onCopy!(text)} aria-label="Copy the reply">Copy</button> : null}
      <div className="chat-assistant-body">
        {fold
          ? <>
              {m.parts.map((p, i) => p.kind === "tool" ? <ToolCard key={p.id || `i${p.index}-${i}`} tool={p} files={host.files} /> : null)}
              <button type="button" className="chat-collapsed" title="Show full reply" aria-label="Show full reply" aria-expanded={false} onClick={() => onToggle?.(m.id, true)}>
                <span className="chat-muted">{replyPreview(text)}</span>
                <span aria-hidden="true" className="chat-muted"> {"\u25BE"}</span>
              </button>
            </>
          : m.parts.map((p, i) => p.kind === "text"
            ? <StreamingText key={i} part={p} host={host} live={live && i === lastIdx} />
            : <ToolCard key={p.id || `i${p.index}-${i}`} tool={p} files={host.files} />)}
        {live && m.parts.length === 0 && <p className="chat-muted" role="status">Thinking…</p>}
        {m.notices.filter((n) => n.visible).map((n, i) => <NoticeLine key={i} n={n} host={host} />)}
        {m.status === "aborted" && <p className="chat-muted">Stopped.</p>}
        {m.status === "error" && host.onRetry ? <button type="button" className="chat-link-btn" onClick={host.onRetry}>Retry this turn</button> : null}
        {m.usage && !live && <p className="chat-muted" title={usageTooltip(m.usage)}>{compactTokenCount(billableTokens(m.usage))} tokens</p>}
        {collapsible && onToggle && !fold && !live && <button type="button" className="chat-link-btn" aria-expanded={true} aria-label="Collapse this reply" onClick={() => onToggle(m.id, false)}>Collapse</button>}
      </div>
    </article>
  );
}

export interface CollapseProps {
  /** An older assistant reply the reader has not expanded: shown as a one-line preview. */
  collapsed?: boolean;
  /** An older reply (not the latest): an expanded one offers Collapse. */
  collapsible?: boolean;
  /** Stable across renders (the row stays memoised while another message streams): expand or fold reply `id`. */
  onToggle?: (id: string, expand: boolean) => void;
}

export const MessageView = memo(function MessageView({ m, host, collapsed, collapsible, onToggle }: { m: Message; host: MessageHost } & CollapseProps) {
  if (m.role === "user") {
    // The Mac labels each turn and right-aligns the user's message in a narrow accent bubble.
    return (
      <article className="chat-msg chat-user-row" aria-label="Your message">
        <div className="chat-turn">
          <span className="chat-role">You</span>
          {host.onCopy ? <button type="button" className="chat-copy" onClick={() => host.onCopy!(m.text)} aria-label="Copy your message">Copy</button> : null}
          <div className="chat-user-bubble"><p>{m.text}</p></div>
        </div>
      </article>
    );
  }
  return <Assistant m={m} host={host} collapsed={collapsed} collapsible={collapsible} onToggle={onToggle} />;
});
