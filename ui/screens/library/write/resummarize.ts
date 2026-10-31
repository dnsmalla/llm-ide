// "Re-summarise" for a meeting note: send its transcript to the core (`POST /kb/summarize`, the route the
// Mac uses), then rewrite ONLY what the Mac rewrites (MeetingFileStore.writeSummary): the frontmatter keys
// `gist`, `tldr`, `summary_generated_at`, `summary_model`, and the summary section between the header and
// `## Transcript`. The transcript and every other header line stay byte-identical. The save is a
// compare-and-swap, so a note edited meanwhile is never overwritten.
//
// Cancel: the request is aborted; nothing is written. The route has a 3-minute server ceiling.

import { locateHeader, setKey } from "./frontmatter-edit.ts";
import { parseNote, fmList, fmString, fmInt } from "../frontmatter.ts";
import { toWriteError, WriteError, type SavedNote, type WriteHost } from "./write-host.ts";

/** Transcript characters sent at most (the server caps the prompt at 500,000). */
export const TRANSCRIPT_MAX_CHARS = 400_000;

export interface SummarizeReply {
  gist: string;
  tldr: string[];
  full: string;
  actions: { owner: string | null; text: string; due: string | null }[];
  decisions: { text: string }[];
  blockers: { text: string }[];
  model: string;
  generatedAtMs: number;
}

export type SummarizeErrorCode = "no_transcript" | "unauthorized" | "timeout" | "rate_limited" | "failed" | "bad_reply" | "unavailable" | "cancelled" | "conflict" | "write_failed";

export class SummarizeError extends Error {
  readonly code: SummarizeErrorCode;
  constructor(code: SummarizeErrorCode) {
    super(code);
    this.name = "SummarizeError";
    this.code = code;
  }
}

export function summarizeErrorText(code: SummarizeErrorCode): string {
  switch (code) {
    case "no_transcript":
      return "This note has no transcript section to summarise.";
    case "unauthorized":
      return "Sign in to the core again, then retry.";
    case "timeout":
      return "Summarising took too long. The transcript may be very long or the AI service slow. Nothing was changed.";
    case "rate_limited":
      return "The AI service is rate limited right now. Try again in a moment. Nothing was changed.";
    case "unavailable":
      return "The core is not reachable. Nothing was changed.";
    case "cancelled":
      return "Cancelled. Nothing was changed.";
    case "conflict":
      return "The note changed while it was being summarised, so the new summary was not written. Reopen the note and try again.";
    case "bad_reply":
      return "The core answered with something unexpected. Nothing was changed.";
    case "write_failed":
      return "The summary was made but the note could not be saved.";
    default:
      return "The summary could not be made. Nothing was changed.";
  }
}

export interface SummarizeCore {
  /** POST /kb/summarize; resolves with the HTTP status and decoded body (never throws for a non-2xx answer). */
  summarize(body: Record<string, unknown>, signal: AbortSignal): Promise<{ status: number; body: unknown }>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strOr = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);

export function decodeSummary(v: unknown): SummarizeReply | null {
  if (!isRecord(v) || typeof v.full !== "string") return null;
  const items = (a: unknown): Record<string, unknown>[] => (Array.isArray(a) ? a.filter(isRecord).slice(0, 200) : []);
  return {
    gist: strOr(v.gist),
    tldr: (Array.isArray(v.tldr) ? v.tldr : []).filter((x): x is string => typeof x === "string").slice(0, 50),
    full: v.full,
    actions: items(v.actions).map((a) => ({ owner: typeof a.owner === "string" && a.owner !== "" ? a.owner : null, text: strOr(a.text), due: typeof a.due === "string" && a.due !== "" ? a.due : null })).filter((a) => a.text !== ""),
    decisions: items(v.decisions).map((d) => ({ text: strOr(d.text) })).filter((d) => d.text !== ""),
    blockers: items(v.blockers).map((b) => ({ text: strOr(b.text) })).filter((b) => b.text !== ""),
    model: strOr(v.model, "unknown"),
    generatedAtMs: typeof v.generated_at === "number" && Number.isFinite(v.generated_at) ? v.generated_at : 0,
  };
}

const TRANSCRIPT_LINE = /^## Transcript[ \t]*\r?$/m;

/** Index just after the closing fence line of the header, or 0 when there is none. */
function bodyStart(text: string): number {
  const loc = locateHeader(text);
  if (!loc) return 0;
  const nl = text.indexOf("\n", loc.closeStart);
  return nl < 0 ? text.length : nl + 1;
}

/** The transcript text (after the `## Transcript` heading), or null when the note has none. */
export function extractTranscript(text: string): string | null {
  const start = bodyStart(text);
  const body = text.slice(start);
  const m = TRANSCRIPT_LINE.exec(body);
  if (!m) return null;
  const t = body.slice(m.index + m[0].length).replaceAll("\r\n", "\n").trim();
  return t === "" ? null : t;
}

/** The summary section the Mac writes (MeetingFileStore.renderSummarySection). */
export function renderSummarySection(s: SummarizeReply): string {
  let out = `\n${s.full}\n`;
  if (s.actions.length) {
    out += "\n## Actions\n";
    for (const a of s.actions) out += `- [ ] ${a.owner ? `**${a.owner}** — ` : ""}${a.text}${a.due ? ` (due ${a.due})` : ""}\n`;
  }
  if (s.decisions.length) {
    out += "\n## Decisions\n";
    for (const d of s.decisions) out += `- ${d.text}\n`;
  }
  if (s.blockers.length) {
    out += "\n## Blockers\n";
    for (const b of s.blockers) out += `- ${b.text}\n`;
  }
  return `${out}\n`;
}

/** Writes the summary into `text` (header keys + the section above the transcript). Null when there is no transcript heading. */
export function applySummary(text: string, s: SummarizeReply): string | null {
  const start = bodyStart(text);
  const body = text.slice(start);
  const m = TRANSCRIPT_LINE.exec(body);
  if (!m) return null;
  const crlf = text.includes("\r\n");
  const section = crlf ? renderSummarySection(s).replaceAll("\n", "\r\n") : renderSummarySection(s);
  let out = text.slice(0, start) + section + body.slice(m.index);
  out = setKey(out, "gist", s.gist);
  out = setKey(out, "tldr", s.tldr);
  out = setKey(out, "summary_generated_at", new Date(s.generatedAtMs || 0).toISOString());
  out = setKey(out, "summary_model", s.model);
  return out;
}

/** The request body the Mac sends (LlmIdeAPIClient.summarize). */
export function buildRequest(text: string, transcript: string): { body: Record<string, unknown>; truncated: boolean } {
  const p = parseNote(text);
  const clipped = transcript.length > TRANSCRIPT_MAX_CHARS;
  const startedAt = fmString(p.data, "started_at");
  const duration = fmInt(p.data, "duration_seconds");
  return {
    truncated: clipped,
    body: {
      transcript: clipped ? transcript.slice(0, TRANSCRIPT_MAX_CHARS) : transcript,
      title: fmString(p.data, "title") ?? "",
      language: fmString(p.data, "language") ?? "en",
      ...(startedAt ? { started_at: startedAt } : null),
      ...(duration !== null ? { duration_seconds: duration } : null),
      participants: fmList(p.data, "participants"),
    },
  };
}

export type SummarizePhase = "reading" | "summarising" | "saving";

export interface ResummarizeDeps {
  host: WriteHost;
  core: SummarizeCore;
  signal: AbortSignal;
  onPhase: (p: SummarizePhase) => void;
}

export interface ResummarizeResult {
  saved: SavedNote;
  text: string;
  truncated: boolean;
}

function statusError(status: number): SummarizeError {
  if (status === 401 || status === 403) return new SummarizeError("unauthorized");
  if (status === 429) return new SummarizeError("rate_limited");
  if (status === 504 || status === 408) return new SummarizeError("timeout");
  if (status === 404) return new SummarizeError("unavailable");
  return new SummarizeError("failed");
}

export async function resummarize(rel: string, deps: ResummarizeDeps): Promise<ResummarizeResult> {
  const cancelled = (): SummarizeError => new SummarizeError("cancelled");
  deps.onPhase("reading");
  let opened;
  try {
    opened = await deps.host.open(rel);
  } catch (e) {
    throw new SummarizeError(toWriteError(e).code === "not_found" ? "failed" : "failed");
  }
  if (deps.signal.aborted) throw cancelled();
  const transcript = extractTranscript(opened.text);
  if (transcript === null) throw new SummarizeError("no_transcript");
  const req = buildRequest(opened.text, transcript);
  deps.onPhase("summarising");
  let res;
  try {
    res = await deps.core.summarize(req.body, deps.signal);
  } catch (e) {
    if (deps.signal.aborted) throw cancelled();
    const code = (e as { code?: unknown })?.code;
    throw new SummarizeError(code === "TIMEOUT" ? "timeout" : "unavailable");
  }
  if (deps.signal.aborted) throw cancelled();
  if (res.status < 200 || res.status >= 300) throw statusError(res.status);
  const reply = decodeSummary(res.body);
  if (!reply) throw new SummarizeError("bad_reply");
  deps.onPhase("saving");
  // The note may have been edited while the model worked: write against the hash we read, so a change is a conflict.
  const next = applySummary(opened.text, reply);
  if (next === null) throw new SummarizeError("no_transcript");
  try {
    const saved = await deps.host.save(rel, next, opened.bom, opened.hash);
    return { saved, text: next, truncated: req.truncated };
  } catch (e) {
    const err = e instanceof WriteError ? e : toWriteError(e);
    throw new SummarizeError(err.code === "conflict" ? "conflict" : "write_failed");
  }
}
