// Loading and describing ONE note for the viewer. Pure apart from the host reads; tested with node.
//
// A note is read through bounded chunks (the host never returns more than 1 MB per call) up to a
// viewer cap, so a huge file shows its first part with a notice instead of freezing the page.

import { fmDateMs, fmInt, fmList, fmString, parseNote, type FmData, type ParsedNote } from "./frontmatter.ts";
import { NotesError, toNotesError, type NotesHost } from "./host.ts";
import { formatDate, formatDuration, PLATFORM_SOURCES, type NoteRecord } from "./notes-model.ts";
import { parseMeetingBody, type MeetingBody } from "./meeting.ts";

export const VIEW_MAX_BYTES = 2 * 1024 * 1024;
const CHUNK_BYTES = 256 * 1024;

export interface LoadedNote {
  rel: string;
  text: string;
  size: number;
  mtimeMs: number;
  /** The file is larger than the viewer cap: only the first part was read. */
  truncated: boolean;
}

/** Reads `rel` in chunks up to `maxBytes`; aborts promptly; throws a `NotesError`. */
export async function loadNote(host: NotesHost, rel: string, signal: AbortSignal, maxBytes: number = VIEW_MAX_BYTES): Promise<LoadedNote> {
  let text = "";
  let offset = 0;
  let size = 0;
  let mtimeMs = 0;
  for (;;) {
    if (signal.aborted) throw new NotesError("io", "aborted");
    let c;
    try {
      c = await host.read(rel, offset, CHUNK_BYTES);
    } catch (e) {
      throw toNotesError(e);
    }
    if (signal.aborted) throw new NotesError("io", "aborted");
    text += c.text;
    size = c.size;
    mtimeMs = c.mtimeMs;
    if (c.nextOffset === null) return { rel, text, size, mtimeMs, truncated: false };
    offset = c.nextOffset;
    if (offset >= maxBytes) return { rel, text, size, mtimeMs, truncated: true };
  }
}

export type NoteKind = "meeting" | "markdown" | "text";

export interface MetaItem {
  label: string;
  value: string;
}

export interface NoteView {
  kind: NoteKind;
  title: string;
  meta: MetaItem[];
  /** Every frontmatter key, shown in the metadata panel (values as text). */
  frontmatter: { key: string; value: string }[];
  hasFrontmatter: boolean;
  body: string;
  meeting: MeetingBody | null;
  gist: string | null;
  tldr: string[];
  truncated: boolean;
  /** iCloud or oversize notices etc. shown above the body. */
  notices: string[];
}

const HAS_TRANSCRIPT = /^## Transcript[ \t]*$/m;

function fmValueText(v: string | string[] | null): string {
  if (v === null) return "";
  return Array.isArray(v) ? v.join(", ") : v;
}

export function frontmatterRows(data: FmData): { key: string; value: string }[] {
  const rows: { key: string; value: string }[] = [];
  for (const key of Object.keys(data)) {
    if (rows.length >= 100) break;
    rows.push({ key, value: fmValueText(data[key] ?? null).slice(0, 2000) });
  }
  return rows;
}

export function describeNote(rec: NoteRecord | undefined, note: LoadedNote): NoteView {
  const name = note.rel.slice(note.rel.lastIndexOf("/") + 1);
  const isText = /\.txt$/i.test(name);
  const parsed: ParsedNote = isText ? { hasFrontmatter: false, data: Object.create(null) as FmData, body: note.text, header: "" } : parseNote(note.text);
  const d = parsed.data;
  const platform = (fmString(d, "platform") ?? fmString(d, "source") ?? "").toLowerCase();
  const meetingish = !isText && (HAS_TRANSCRIPT.test(parsed.body) || (platform !== "" && PLATFORM_SOURCES[platform] === "meeting") || rec?.sourceId === "meeting") && rec?.area !== "llm-doc";
  const title = fmString(d, "title") ?? rec?.title ?? name;
  const meta: MetaItem[] = [];
  const started = fmDateMs(d, "started_at") ?? fmDateMs(d, "date") ?? rec?.dateMs ?? null;
  if (started !== null) meta.push({ label: "Date", value: formatDate(started) });
  const dur = formatDuration(fmInt(d, "duration_seconds"));
  if (dur) meta.push({ label: "Duration", value: dur });
  if (platform) meta.push({ label: "Platform", value: platform });
  const lang = fmString(d, "language");
  if (lang) meta.push({ label: "Language", value: lang.toUpperCase() });
  const people = fmList(d, "participants");
  if (people.length) meta.push({ label: "Participants", value: people.slice(0, 20).join(", ") + (people.length > 20 ? ` and ${people.length - 20} more` : "") });
  const model = fmString(d, "summary_model");
  if (model && model !== "failed") meta.push({ label: "Summarised by", value: model });
  const notices: string[] = [];
  if (note.truncated) notices.push(`This file is ${(note.size / (1024 * 1024)).toFixed(1)} MB. Only the first ${(VIEW_MAX_BYTES / (1024 * 1024)).toFixed(0)} MB is shown.`);
  if (model === "failed") notices.push("The summary failed when this meeting was processed. Re-summarising is not available in this version.");
  return {
    kind: isText ? "text" : meetingish ? "meeting" : "markdown",
    title,
    meta,
    frontmatter: frontmatterRows(d),
    hasFrontmatter: parsed.hasFrontmatter,
    body: parsed.body,
    meeting: meetingish ? parseMeetingBody(parsed.body) : null,
    gist: fmString(d, "gist"),
    tldr: fmList(d, "tldr"),
    truncated: note.truncated,
    notices,
  };
}
