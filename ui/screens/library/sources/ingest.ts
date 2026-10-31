// Fetch -> note files -> mark seen, for the connectors whose items become notes (Email, Slack, MCP-backed such
// as Miro). The core's fetch routes return NEW items only and own the dedup ledger; this module turns each item
// into a raw note under `source/<kind>/YYYY/MM/` through `WriteHost.create` (which never overwrites), and only
// THEN tells the core the item was seen.
//
// Loss/duplication rules:
//  - An item is marked seen only when its note exists on disk: written now, or already there (`exists`, a
//    previous run wrote it but crashed before marking). A failed write is NOT marked, so it is fetched again.
//  - When anything failed, the forward-only high-water mark (email `lastFetchedAt`, slack `lastTs`) is NOT
//    advanced, so the failed item is not skipped over; the seen ledger de-duplicates the replay.
//  - Cancel is checked between items; what was written stays, and the seen call still covers exactly those.
//
// Not built here (blocked-by, see the parity checklist): the Mac also classifies each item with an LLM
// (`/kb/email/classify`, `/kb/mcp-connector/classify`) and writes a generated note under `llm-doc/`; the
// desktop writes the raw capture only.

import { fmtDay, slugify } from "./names.ts";
import { sha256HexWebCrypto } from "../index-rebuild.ts";
import { renderNote } from "../write/frontmatter-edit.ts";
import { toWriteError, type WriteHost } from "../write/write-host.ts";
import { callOk, SourceError, mapThrown, type SourceErrorCode, type SourcesCore } from "./source-core.ts";
import type { EmailConfig, SlackChannel } from "./source-config.ts";

export const BODY_MAX_CHARS = 200_000;
export const FETCH_TIMEOUT_MS = 120_000;
export const MCP_FETCH_TIMEOUT_MS = 180_000;
const MAX_ITEMS = 500;

export type FetchPhase = "idle" | "fetching" | "writing" | "marking" | "done" | "cancelled" | "error";

export interface FetchProgress {
  phase: FetchPhase;
  fetched: number;
  written: number;
  /** Already on disk from an earlier run (counted as imported, marked seen). */
  existing: number;
  failed: number;
  /** Server-side skips (oversize, over the per-fetch cap). */
  skipped: number;
  /** The server has more to give: fetch again. */
  more: boolean;
  error: SourceErrorCode | null;
  serverCode: string | null;
}

export const IDLE_FETCH: FetchProgress = { phase: "idle", fetched: 0, written: 0, existing: 0, failed: 0, skipped: 0, more: false, error: null, serverCode: null };

export function fetchMessage(p: FetchProgress): string {
  const n = (x: number): string => x.toLocaleString();
  switch (p.phase) {
    case "fetching":
      return "Fetching from the server…";
    case "writing":
      return `Saving notes: ${n(p.written + p.existing + p.failed)} of ${n(p.fetched)}…`;
    case "marking":
      return "Recording what was imported…";
    case "idle":
      return "";
    default: {
      const parts = [`${n(p.written)} new ${p.written === 1 ? "note" : "notes"} saved`];
      if (p.existing) parts.push(`${n(p.existing)} already there`);
      if (p.failed) parts.push(`${n(p.failed)} could not be saved and will be fetched again`);
      if (p.skipped) parts.push(`${n(p.skipped)} skipped by the server (too large or over the per-fetch limit)`);
      if (p.more) parts.push("more is available: fetch again");
      return `${p.phase === "cancelled" ? "Stopped. " : ""}${parts.join("; ")}.`;
    }
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : "");

function validDate(v: unknown, fallback: number): number {
  const t = typeof v === "string" || typeof v === "number" ? new Date(v).getTime() : NaN;
  return Number.isFinite(t) ? t : fallback;
}

export interface Plan {
  rel: string;
  text: string;
  /** The id the core's seen ledger knows this item by. */
  id: string;
}

async function hash8(s: string): Promise<string> {
  return (await sha256HexWebCrypto(new TextEncoder().encode(s))).slice(0, 8);
}

function dayDir(kind: string, ms: number): { dir: string; day: string; clock: string } {
  const d = fmtDay(ms);
  return { dir: `source/${kind}/${d.year}/${d.month}`, day: `${d.year}-${d.month}-${d.day}`, clock: `${d.hh}${d.mm}${d.ss}` };
}

const clip = (s: string): string => (s.length > BODY_MAX_CHARS ? `${s.slice(0, BODY_MAX_CHARS)}\n\n[truncated]\n` : s);

// ---- email -----------------------------------------------------------------------------------

export interface EmailMessage {
  messageId: string;
  subject: string;
  from: string;
  date: string;
  text: string;
}

export function decodeEmail(v: unknown): EmailMessage | null {
  if (!isRecord(v) || typeof v.messageId !== "string" || v.messageId === "") return null;
  return { messageId: v.messageId.slice(0, 998), subject: str(v.subject).slice(0, 500), from: str(v.from).slice(0, 500), date: str(v.date), text: str(v.text) };
}

export async function planEmail(m: EmailMessage, nowMs: number): Promise<Plan> {
  const t = validDate(m.date, nowMs);
  const { dir, day, clock } = dayDir("emails", t);
  const h = await hash8(m.messageId);
  const rel = `${dir}/${day}-${clock}-${slugify(m.subject || "email")}-${h}.md`;
  const sourceHash = await sha256HexWebCrypto(new TextEncoder().encode(m.messageId));
  const text = renderNote(
    [
      ["id", `email-${h}`],
      ["title", m.subject || "Email"],
      ["platform", "email"],
      ["date", new Date(t).toISOString()],
      ["from", m.from],
      ["message_id", m.messageId],
      ["source_hash", sourceHash],
    ],
    `${clip(m.text.replace(/\r\n/g, "\n"))}\n`,
  );
  return { rel, text, id: m.messageId };
}

export interface RunDeps {
  core: SourcesCore;
  write: WriteHost;
  signal: AbortSignal;
  onProgress: (p: FetchProgress) => void;
  now?: () => number;
}

class Tracker {
  p: FetchProgress = { ...IDLE_FETCH };
  private readonly onProgress: (p: FetchProgress) => void;
  constructor(onProgress: (p: FetchProgress) => void) {
    this.onProgress = onProgress;
  }
  set(patch: Partial<FetchProgress>): void {
    this.p = { ...this.p, ...patch };
    this.onProgress(this.p);
  }
}

/** Writes each plan; returns the ids that now exist on disk (written or already there). */
async function writePlans(plans: readonly Plan[], deps: RunDeps, t: Tracker): Promise<{ present: string[]; failed: number }> {
  const present: string[] = [];
  let failed = 0;
  for (const plan of plans) {
    if (deps.signal.aborted) break;
    try {
      await deps.write.create(plan.rel, plan.text);
      present.push(plan.id);
      t.set({ written: t.p.written + 1 });
    } catch (e) {
      if (toWriteError(e).code === "exists") {
        present.push(plan.id);
        t.set({ existing: t.p.existing + 1 });
      } else {
        failed += 1;
        t.set({ failed: t.p.failed + 1 });
      }
    }
  }
  return { present, failed };
}

function finish(t: Tracker, signal: AbortSignal): FetchProgress {
  t.set({ phase: signal.aborted ? "cancelled" : "done" });
  return t.p;
}

function fail(t: Tracker, e: unknown, signal: AbortSignal): FetchProgress {
  const err = e instanceof SourceError ? e : mapThrown(e, signal);
  t.set({ phase: err.code === "cancelled" ? "cancelled" : "error", error: err.code === "cancelled" ? null : err.code, serverCode: err.serverCode });
  return t.p;
}

export async function fetchEmail(cfg: EmailConfig, deps: RunDeps): Promise<FetchProgress> {
  const t = new Tracker(deps.onProgress);
  const now = (deps.now ?? Date.now)();
  t.set({ phase: "fetching" });
  try {
    const body = await callOk<unknown>(
      deps.core,
      "POST",
      "/kb/email/fetch",
      { host: cfg.host.trim(), port: cfg.port, secure: cfg.secure, user: cfg.user.trim(), mailbox: cfg.mailbox, lookbackDays: cfg.lookbackDays, unreadOnly: cfg.unreadOnly, fromFilter: cfg.fromFilter, authMethod: cfg.authMethod, markRead: cfg.markRead },
      deps.signal,
      FETCH_TIMEOUT_MS,
    );
    const r = isRecord(body) ? body : {};
    const msgs = (Array.isArray(r.messages) ? r.messages : []).slice(0, MAX_ITEMS).map(decodeEmail).filter((m): m is EmailMessage => m !== null);
    const sk = isRecord(r.skipped) ? r.skipped : {};
    t.set({ phase: "writing", fetched: msgs.length, skipped: (Number(sk.oversize) || 0) + (Number(sk.overCap) || 0), more: (Number(sk.overCap) || 0) > 0 });
    const plans: Plan[] = [];
    for (const m of msgs) plans.push(await planEmail(m, now));
    const { present, failed } = await writePlans(plans, deps, t);
    if (present.length > 0 || (failed === 0 && !deps.signal.aborted)) {
      t.set({ phase: "marking" });
      // Never abortable: the notes are written, so the ledger must be told (aborting here would re-import them as duplicates).
      await callOk(deps.core, "POST", "/kb/email/seen", { messageIds: present, lastFetchedAt: failed === 0 && !deps.signal.aborted ? new Date(now).toISOString() : null }, new AbortController().signal, 30_000);
    }
    return finish(t, deps.signal);
  } catch (e) {
    return fail(t, e, deps.signal);
  }
}

/** First connection of a forward-only mailbox: start capturing from now (the Mac does the same). */
export async function startEmailFromNow(core: SourcesCore, signal: AbortSignal, nowMs: number): Promise<void> {
  await callOk(core, "POST", "/kb/email/seen", { messageIds: [], lastFetchedAt: new Date(nowMs).toISOString() }, signal, 30_000);
}

// ---- slack -----------------------------------------------------------------------------------

export interface SlackMessage {
  ts: string;
  user: string;
  text: string;
}

export function decodeSlack(v: unknown): SlackMessage | null {
  if (!isRecord(v) || typeof v.ts !== "string" || !/^\d{1,12}\.\d{1,9}$/.test(v.ts)) return null;
  return { ts: v.ts, user: str(v.user).slice(0, 80), text: str(v.text) };
}

/** One note per channel per fetch batch: messages in time order as `[HH:MM:SS] **user**: text` lines (the transcript form). */
export async function planSlack(channel: SlackChannel, msgs: readonly SlackMessage[], nowMs: number): Promise<Plan> {
  const sorted = [...msgs].sort((a, b) => Number(a.ts) - Number(b.ts));
  const first = Number(sorted[0]!.ts) * 1000;
  const { dir, day } = dayDir("slack", first);
  const h = await hash8(`${channel.id}:${sorted[0]!.ts}`);
  const name = channel.name.trim() === "" ? channel.id : channel.name;
  const lines = sorted.map((m) => {
    const d = fmtDay(Number(m.ts) * 1000);
    const text = m.text.replace(/\r?\n/g, "\n  ");
    return `[${d.hh}:${d.mm}:${d.ss}] **${(m.user || "unknown").replace(/\*/g, "")}**: ${text}`;
  });
  const text = renderNote(
    [
      ["id", `slack-${h}`],
      ["title", `#${name}`],
      ["platform", "slack"],
      ["date", new Date(first || nowMs).toISOString()],
      ["channel_id", channel.id],
      ["first_ts", sorted[0]!.ts],
      ["last_ts", sorted[sorted.length - 1]!.ts],
    ],
    `${clip(lines.join("\n"))}\n`,
  );
  return { rel: `${dir}/${day}-${slugify(name)}-${h}.md`, text, id: channel.id };
}

export async function fetchSlack(channels: readonly SlackChannel[], lookbackDays: number, deps: RunDeps): Promise<FetchProgress> {
  const t = new Tracker(deps.onProgress);
  const now = (deps.now ?? Date.now)();
  t.set({ phase: "fetching" });
  try {
    for (const ch of channels) {
      if (deps.signal.aborted) break;
      const body = await callOk<unknown>(deps.core, "POST", "/kb/slack/fetch", { channelId: ch.id, lookbackDays }, deps.signal, FETCH_TIMEOUT_MS);
      const r = isRecord(body) ? body : {};
      const msgs = (Array.isArray(r.messages) ? r.messages : []).slice(0, MAX_ITEMS).map(decodeSlack).filter((m): m is SlackMessage => m !== null);
      const sk = isRecord(r.skipped) ? Number(r.skipped.overCap) || 0 : 0;
      t.set({ phase: "writing", fetched: t.p.fetched + msgs.length, skipped: t.p.skipped + sk, more: t.p.more || sk > 0 });
      if (msgs.length === 0) continue;
      const plan = await planSlack(ch, msgs, now);
      const before = t.p.failed;
      const { present } = await writePlans([plan], deps, t);
      if (present.length > 0) {
        const ok = t.p.failed === before && !deps.signal.aborted;
        const ts = msgs.map((m) => m.ts).sort((a, b) => Number(a) - Number(b));
        await callOk(deps.core, "POST", "/kb/slack/seen", { channelId: ch.id, messageTs: ts, lastTs: ok ? ts[ts.length - 1] : null }, new AbortController().signal, 30_000);
      }
    }
    return finish(t, deps.signal);
  } catch (e) {
    return fail(t, e, deps.signal);
  }
}

// ---- MCP-backed connectors (Miro) --------------------------------------------------------------

export interface McpItem {
  id: string;
  title: string;
  fields: [string, string][];
  body: string;
}

const MCP_FIELD_KEYS = ["Title", "Board", "ItemType", "Date", "Link"] as const;
const BODY_KEYS = ["text", "Text", "body", "Body", "content", "Content"];

/** Tolerant item shaping: the item field names are an unverified guess for Miro (see the connector spec), so
 *  whatever scalar fields arrive are kept rather than assuming a shape. */
export function decodeMcpItem(v: unknown): McpItem | null {
  if (!isRecord(v)) return null;
  const id = str(v.id) || str(v.ItemId) || str(v.itemId);
  if (id === "") return null;
  const fields: [string, string][] = [];
  for (const k of MCP_FIELD_KEYS) {
    const val = str(v[k]);
    if (val !== "") fields.push([k, val.slice(0, 500)]);
  }
  let body = "";
  for (const k of BODY_KEYS) {
    if (typeof v[k] === "string" && (v[k] as string).trim() !== "") {
      body = v[k] as string;
      break;
    }
  }
  if (body === "") {
    const rest = Object.entries(v)
      .filter(([k, val]) => !MCP_FIELD_KEYS.includes(k as never) && k !== "id" && k !== "ItemId" && k !== "itemId" && typeof val === "string" && k.length <= 40)
      .slice(0, 20)
      .map(([k, val]) => `${k}: ${(val as string).slice(0, 2000)}`);
    body = rest.join("\n");
  }
  return { id: id.slice(0, 200), title: fields.find(([k]) => k === "Title")?.[1] ?? "", fields, body };
}

export async function planMcp(connectorId: string, it: McpItem, nowMs: number): Promise<Plan> {
  const dateField = it.fields.find(([k]) => k === "Date")?.[1];
  const t = validDate(dateField, nowMs);
  const { dir, day } = dayDir(connectorId, t);
  const h = await hash8(`${connectorId}:${it.id}`);
  const title = it.title || `${connectorId} item`;
  const text = renderNote(
    [
      ["id", `${connectorId}-${h}`],
      ["title", title],
      ["source", connectorId],
      ["date", new Date(t).toISOString()],
      ["item_id", it.id],
      ...it.fields.filter(([k]) => k !== "Title" && k !== "Date").map(([k, v]) => [k.replace(/[^A-Za-z0-9_]/g, "_").toLowerCase(), v] as [string, string]),
    ],
    `${clip(it.body.replace(/\r\n/g, "\n"))}\n`,
  );
  return { rel: `${dir}/${day}-${slugify(title)}-${h}.md`, text, id: it.id };
}

export function isConnectorId(id: string): boolean {
  return /^[a-z][a-z0-9-]{1,20}$/.test(id);
}

export async function fetchMcp(connectorId: string, deps: RunDeps, limit = 50): Promise<FetchProgress> {
  const t = new Tracker(deps.onProgress);
  const now = (deps.now ?? Date.now)();
  if (!isConnectorId(connectorId)) return fail(t, new SourceError("validation"), deps.signal);
  t.set({ phase: "fetching" });
  try {
    const body = await callOk<unknown>(deps.core, "POST", "/kb/mcp-connector/fetch", { id: connectorId, limit }, deps.signal, MCP_FETCH_TIMEOUT_MS);
    const r = isRecord(body) ? body : {};
    const items = (Array.isArray(r.items) ? r.items : []).slice(0, MAX_ITEMS).map(decodeMcpItem).filter((x): x is McpItem => x !== null);
    const fails = Array.isArray(r.failures) ? r.failures.length : 0;
    const sk = isRecord(r.skipped) ? Number(r.skipped.overCap) || 0 : 0;
    t.set({ phase: "writing", fetched: items.length, skipped: sk + fails, more: r.drained === false || sk > 0 });
    const plans: Plan[] = [];
    for (const it of items) plans.push(await planMcp(connectorId, it, now));
    const { present } = await writePlans(plans, deps, t);
    if (present.length > 0) {
      t.set({ phase: "marking" });
      await callOk(deps.core, "POST", "/kb/mcp-connector/seen", { id: connectorId, itemIds: present }, new AbortController().signal, 30_000);
    }
    return finish(t, deps.signal);
  } catch (e) {
    return fail(t, e, deps.signal);
  }
}
