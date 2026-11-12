// Read-only Host API v1 views: usage numbers, the user's chats, and one chat's history. Host text renders as text.
import { Markdown } from "@llmide/screens/chat/MarkdownView.tsx";
import type { HostApiCapability } from "../host-api/types.generated.ts";
import type { ReadState } from "../read/controller.ts";
import { Badge, Banner, Button, Card, EmptyState, ListRow, RowList, Skeleton } from "../ui/index.ts";

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

const copyText = (text: string) => { void globalThis.navigator?.clipboard?.writeText(text).catch(() => undefined); };
const pctOf = (m: Model) => (m.limit > 0 ? Math.min(100, Math.round((m.used / m.limit) * 100)) : null);

export function ReadPanel(p: ReadPanelProps) {
  if (!p.capabilities.has("read")) return null;
  const { state } = p;
  if (state.open) {
    const o = state.open;
    return (
      <section className="web-read web-read-open" aria-label={`Chat: ${o.title}`}>
        <header className="web-read-head">
          <Button size="sm" variant="secondary" icon="chevron-left" onClick={p.onClose}>Back to the phone chat</Button>
          <h2>{o.title}</h2>
          <Badge tone="neutral">Read-only</Badge>
        </header>
        {state.error && <Banner tone="error">{state.error}</Banner>}
        {o.nextBeforeSeq != null && <Button size="sm" variant="secondary" onClick={p.onOlder} disabled={state.loading}>Show older</Button>}
        <ul className="web-list">
          {o.messages.map((m) => m.role === "user"
            ? <li key={m.seq} className="web-msg web-user">{m.content}</li>
            : <li key={m.seq} className="web-msg web-assistant"><Markdown text={m.content} onOpenLink={openLink} onCopy={copyText} /></li>)}
        </ul>
      </section>
    );
  }
  const loadingFirst = state.loading && state.sessions.length === 0 && !state.usage;
  return (
    <aside className="web-read" aria-label="Chats, meetings, plans and usage">
      {state.error && <Banner tone="error">{state.error}</Banner>}
      {state.usage && state.usage.length > 0 && (
        <Card as="section" title="Usage" aria-label="Usage" headingLevel="h2">
          {state.usage.map((prov) => (
            <ul key={prov.provider} className="web-read-usage">
              {prov.models.map((m) => {
                const pct = pctOf(m);
                return (
                  <li key={m.model} data-state={m.state}>
                    <span>{meter(m)}</span>
                    {pct !== null && <span className="web-meter" role="img" aria-label={`${pct}% used`} data-state={m.state}><i style={{ width: `${pct}%` }} /></span>}
                  </li>
                );
              })}
            </ul>
          ))}
        </Card>
      )}
      <Card as="section" title="Chats" aria-label="Chats" flush headingLevel="h2">
        {loadingFirst ? <div className="web-skel"><Skeleton height={44} /><Skeleton height={44} /><Skeleton height={44} /></div>
          : state.sessions.length === 0 ? <EmptyState icon="rotate-ccw-clock" title="No chats yet" headingLevel="h3">Chats you start from this browser or the desktop appear here, read-only.</EmptyState> : (
            <RowList>
              {state.sessions.map((c) => (
                <li key={c.id}>
                  {c.phoneChat
                    ? <ListRow icon="message-square" title={<span>{c.title} (live chat)</span>} subtitle="The chat you can send into" />
                    : <ListRow icon="message-circle" title={c.title} chevron onClick={() => p.onOpen(c.id, c.title)} />}
                </li>
              ))}
            </RowList>
          )}
        {state.nextOffset != null && <div className="web-card-foot"><Button size="sm" variant="secondary" onClick={p.onMore} disabled={state.loading}>More chats</Button></div>}
      </Card>
      {state.meetings && (
        <Card as="section" title="Meetings" aria-label="Meetings" headingLevel="h2">
          {state.meetings.length === 0 ? <p className="chat-muted">No meetings in this snapshot.</p> : (
            <ul className="web-read-chats">
              {state.meetings.map((m) => (
                <li key={m.id}>
                  <details>
                    <summary>{m.title || "Meeting"}{m.date ? ` · ${m.date}` : ""}</summary>
                    {m.participants.length > 0 && <p>With {m.participants.join(", ")}</p>}
                    <ul>{m.notes.map((n, i) => <li key={i}><strong>{n.kind}:</strong> {n.text}</li>)}</ul>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
      {state.plans && (
        <Card as="section" title="Plans" aria-label="Plans" headingLevel="h2">
          {state.plans.length === 0 ? <p className="chat-muted">No plans in this snapshot.</p> : (
            <ul className="web-read-chats">
              {state.plans.map((p) => (
                <li key={p.id}>
                  <details>
                    <summary>{p.title || "Plan"}</summary>
                    {p.goal && <p>{p.goal}</p>}
                    <ul>{p.tasks.map((t, i) => <li key={i}>{t.title} — {t.status}{t.owner ? `, ${t.owner}` : ""}{t.due ? `, due ${t.due}` : ""}</li>)}</ul>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </aside>
  );
}
