// One message: user bubble or assistant parts (streamed text, tool cards, notices). Memoised so a stream
// only re-renders the last message; inside it only the open tail of the text re-parses.
import { editPreviewFor } from "./plan/EditPreview";
import { memo, useState } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import { Markdown } from "./MarkdownView";
import type { AssistantMessage, Message, Notice, TextPart, ToolPart } from "./state";

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

function StreamingText({ part, host, live }: { part: TextPart; host: MessageHost; live: boolean }) {
  const tail = part.open + part.line;
  return (
    <>
      {part.sealed.map((block, i) => <Markdown key={i} text={block} onOpenLink={host.onOpenLink} onCopy={host.onCopy} />)}
      {tail && <Markdown text={tail} onOpenLink={host.onOpenLink} onCopy={host.onCopy} />}
      {live && <span className="chat-caret" aria-hidden="true" />}
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

function NoticeLine({ n }: { n: Notice }) {
  const text = n.count > 1 ? `${n.text} (x${n.count})` : n.text;
  return <StatusBanner severity={n.level === "error" ? "error" : n.level === "warning" ? "warning" : "info"} message={text} />;
}

function Assistant({ m, host }: { m: AssistantMessage; host: MessageHost }) {
  const live = m.status === "streaming";
  const lastIdx = m.parts.length - 1;
  return (
    <article className="chat-msg chat-assistant" aria-label="Assistant message" aria-busy={live}>
      {m.parts.map((p, i) => p.kind === "text"
        ? <StreamingText key={i} part={p} host={host} live={live && i === lastIdx} />
        : <ToolCard key={p.id || `i${p.index}-${i}`} tool={p} files={host.files} />)}
      {live && m.parts.length === 0 && <p className="chat-muted" role="status">Thinking…</p>}
      {m.notices.filter((n) => n.visible).map((n, i) => <NoticeLine key={i} n={n} />)}
      {m.status === "aborted" && <p className="chat-muted">Stopped.</p>}
    </article>
  );
}

export const MessageView = memo(function MessageView({ m, host }: { m: Message; host: MessageHost }) {
  if (m.role === "user") {
    return <article className="chat-msg chat-user" aria-label="Your message"><p>{m.text}</p></article>;
  }
  return <Assistant m={m} host={host} />;
});
