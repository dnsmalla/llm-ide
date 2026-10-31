// Small status components for the Chat header and composer: mode badge, subagent chip, route history popover and
// the ended-chat banner. Text only; everything from the core is sanitised first.
import { useEffect, useRef, useState } from "react";
import { MODES } from "../route";
import type { CoreTransport } from "../transport";
import { safeLine } from "../slash/sanitize";
import type { SubagentSummary } from "./subagents";

/** The mode the turn runs in (picked, or the one the server resolved for Auto). */
export function ModeBadge({ mode, resolved }: { mode: string; resolved: string | null }) {
  const effective = mode === "auto" ? resolved : mode;
  if (!effective) return null;
  const opt = MODES.find((m) => m.id === effective);
  const label = opt?.label ?? safeLine(effective, 24);
  return <span className="chat-badge" data-mode={effective} aria-label={`Mode: ${label}${mode === "auto" ? " (chosen automatically)" : ""}`}>{label}</span>;
}

export function SubagentChip({ summary }: { summary: SubagentSummary }) {
  const [open, setOpen] = useState(false);
  if (summary.runs.length === 0) return null;
  return (
    <div className="chat-subagents">
      <button type="button" className="chat-badge" aria-expanded={open} aria-controls="chat-subagent-list" onClick={() => setOpen(!open)}>{summary.label}</button>
      {open && (
        <ul id="chat-subagent-list" className="chat-popover" aria-label="Subagents in this turn">
          {summary.runs.map((r) => <li key={r.id}>{r.name ?? "subagent"} <span className="chat-muted">{r.state}</span></li>)}
        </ul>
      )}
    </div>
  );
}

export interface RouteEventView { id: number; at: string; kind: string; from: string; to: string; reason: string | null }

const KIND_LABEL: Record<string, string> = { switch: "Switched", cap_reached: "Cap reached", cap_changed: "Cap changed", cooldown: "Cooldown", handoff_built: "Handoff built" };

export function decodeRouteHistory(raw: unknown): { events: RouteEventView[]; degraded: boolean } {
  const o = (raw ?? {}) as { events?: unknown; degraded?: unknown };
  const events: RouteEventView[] = [];
  for (const e of Array.isArray(o.events) ? o.events.slice(-100) : []) {
    const x = e as Record<string, unknown>;
    if (typeof x?.id !== "number" || typeof x.kind !== "string") continue;
    const side = (p: unknown, m: unknown): string => [safeLine(p, 40), safeLine(m, 60)].filter(Boolean).join(" / ");
    events.push({ id: x.id, at: safeLine(x.at, 32), kind: KIND_LABEL[x.kind] ?? safeLine(x.kind, 24), from: side(x.fromProvider, x.fromModel), to: side(x.toProvider, x.toModel), reason: typeof x.reason === "string" ? safeLine(x.reason, 24) : null });
  }
  return { events, degraded: o.degraded === true };
}

/** Switch history of this chat's route (`GET /agent/v2/session/route/history`), loaded when the popover opens. */
export function RouteHistory({ core, chatId }: { core: CoreTransport; chatId: string }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<{ events: RouteEventView[]; degraded: boolean } | null>(null);
  const [error, setError] = useState(false);
  const ac = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!open) return;
    ac.current?.abort();
    const c = new AbortController();
    ac.current = c;
    setError(false);
    core.json<unknown>("GET", `/agent/v2/session/route/history?chatSessionId=${encodeURIComponent(chatId)}`, undefined, c.signal)
      .then((r) => { if (!c.signal.aborted) setData(decodeRouteHistory(r)); })
      .catch(() => { if (!c.signal.aborted) setError(true); });
    return () => c.abort();
  }, [open, core, chatId]);
  return (
    <div className="chat-route-history">
      <button type="button" className="chat-link-btn" aria-expanded={open} aria-controls="chat-route-history-list" onClick={() => setOpen(!open)}>Route history</button>
      {open && (
        <div id="chat-route-history-list" className="chat-popover" role="region" aria-label="Route history">
          {error && <p role="alert" className="chat-error">The route history could not be loaded.</p>}
          {!error && !data && <p className="chat-muted" role="status">Loading…</p>}
          {data?.degraded && <p className="chat-muted">The history store is unavailable; this list may be incomplete.</p>}
          {data && data.events.length === 0 && !error && <p className="chat-muted">No model switches in this chat yet.</p>}
          {data && data.events.length > 0 && (
            <ul>{data.events.map((e) => <li key={e.id}><strong>{e.kind}</strong> {e.from && e.to ? `${e.from} → ${e.to}` : e.to || e.from} <span className="chat-muted">{e.at}{e.reason ? `, ${e.reason}` : ""}</span></li>)}</ul>
          )}
        </div>
      )}
    </div>
  );
}

/** Ended chats open read-only. The core has no `ended` flag on a chat yet, so the marker is read defensively. */
export function isEndedChat(s: object | null | undefined): boolean {
  if (!s) return false;
  const x = s as { endedAt?: unknown; ended?: unknown };
  return x.ended === true || (typeof x.endedAt === "number" && x.endedAt > 0);
}

export const ENDED_REASON = "This chat has ended and is read-only. Start a new chat to continue.";

export function EndedBanner({ onNewChat }: { onNewChat: () => void }) {
  return (
    <div className="chat-ended" role="status">
      <span>{ENDED_REASON}</span>{" "}
      <button type="button" className="chat-link-btn" onClick={onNewChat}>New chat</button>
    </div>
  );
}
