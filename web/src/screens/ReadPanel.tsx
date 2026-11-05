// Read-only Host API v1 views: usage numbers, the user's chats, and one chat's history. Host text renders as text.
import { StatusBanner } from "@llmide/ui-kit";
import { Markdown } from "@llmide/screens/chat/MarkdownView.tsx";
import type { HostApiCapability } from "../host-api/types.generated.ts";
import type { ReadState } from "../read/controller.ts";

export interface ReadPanelProps {
  capabilities: ReadonlySet<HostApiCapability>;
  state: ReadState;
  onOpen: (id: string, title: string) => void;
  onOlder: () => void;
  onClose: () => void;
  onMore: () => void;
}

const openLink = (href: string) => { if (/^https?:\/\//.test(href)) window.open(href, "_blank", "noopener,noreferrer"); };
type Model = NonNullable<ReadState["usage"]>[number]["models"][number];
const meter = (m: Model) =>
  `${m.label ?? m.model}: ${m.limit > 0 ? `${m.used} of ${m.limit}` : m.used} ${m.unit} · ${m.window}${m.limit > 0 ? "" : ", no cap"}`;

export function ReadPanel(p: ReadPanelProps) {
  if (!p.capabilities.has("read")) return null;
  const { state } = p;
  if (state.open) {
    const o = state.open;
    return (
      <section className="web-read" aria-label={`Chat: ${o.title}`}>
        <header className="web-read-head">
          <h2>{o.title}</h2>
          <span className="chat-muted">Read-only</span>
          <button type="button" onClick={p.onClose}>Back to the phone chat</button>
        </header>
        {state.error && <StatusBanner severity="error" message={state.error} />}
        {o.nextBeforeSeq != null && <button type="button" onClick={p.onOlder} disabled={state.loading}>Show older</button>}
        <ul className="web-list">
          {o.messages.map((m) => m.role === "user"
            ? <li key={m.seq} className="web-msg web-user">{m.content}</li>
            : <li key={m.seq} className="web-msg web-assistant"><Markdown text={m.content} onOpenLink={openLink} /></li>)}
        </ul>
      </section>
    );
  }
  return (
    <aside className="web-read" aria-label="Chats and usage">
      {state.error && <StatusBanner severity="error" message={state.error} />}
      {state.usage && (
        <section aria-label="Usage">
          <h2>Usage</h2>
          {state.usage.map((prov) => (
            <ul key={prov.provider} className="web-read-usage">
              {prov.models.map((m) => <li key={m.model} data-state={m.state}>{meter(m)}</li>)}
            </ul>
          ))}
        </section>
      )}
      <section aria-label="Chats">
        <h2>Chats</h2>
        <ul className="web-read-chats">
          {state.sessions.map((c) => (
            <li key={c.id}>
              {c.phoneChat
                ? <span>{c.title} (this device)</span>
                : <button type="button" onClick={() => p.onOpen(c.id, c.title)}>{c.title}</button>}
            </li>
          ))}
        </ul>
        {state.nextOffset != null && <button type="button" onClick={p.onMore} disabled={state.loading}>More chats</button>}
      </section>
    </aside>
  );
}
