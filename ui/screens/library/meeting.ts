// Meeting note body: the summary section above `## Transcript`, the action / decision / blocker
// lists inside it, and the transcript lines. Read-only; pure. Mirrors what the Mac writes
// (MeetingFileStore.renderSummarySection and appendCaption) and reads (MeetingDetailViewModel:
// everything before the first `## Transcript` is the summary, the rest the transcript).

export interface Utterance {
  /** `HH:MM:SS` as written, or null for a continuation line with no timestamp. */
  time: string | null;
  speaker: string | null;
  text: string;
}

export interface ListItem {
  text: string;
  /** `- [x]` task state; null for a plain bullet. */
  done: boolean | null;
}

export interface MeetingBody {
  /** Summary markdown WITHOUT the actions / decisions / blockers sections (shown separately). */
  summaryMarkdown: string;
  actions: ListItem[];
  decisions: ListItem[];
  blockers: ListItem[];
  transcript: Utterance[];
  hasTranscript: boolean;
}

const TRANSCRIPT_HEADING = /^## Transcript[ \t]*$/m;
const LINE = /^\[(\d{1,2}:\d{2}(?::\d{2})?)\][ \t]+\*\*(.+?)\*\*:[ \t]?(.*)$/;
/** Heading variants the note templates use for each list (NoteActionExtractor.actionHeadings and friends). */
const LIST_HEADINGS: Record<"actions" | "decisions" | "blockers", readonly string[]> = {
  actions: ["Actions", "Action items", "To-dos"],
  decisions: ["Decisions"],
  blockers: ["Blockers"],
};

export function parseMeetingBody(body: string): MeetingBody {
  const norm = body.includes("\r\n") ? body.replaceAll("\r\n", "\n") : body;
  const m = TRANSCRIPT_HEADING.exec(norm);
  const summary = m ? norm.slice(0, m.index) : norm;
  const transcriptText = m ? norm.slice(m.index + m[0].length) : "";
  const { rest, lists } = extractLists(summary);
  return {
    summaryMarkdown: rest.trim(),
    actions: lists.actions,
    decisions: lists.decisions,
    blockers: lists.blockers,
    transcript: parseTranscript(transcriptText),
    hasTranscript: m !== null,
  };
}

export function parseTranscript(text: string): Utterance[] {
  const out: Utterance[] = [];
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    const m = LINE.exec(raw);
    if (m) {
      out.push({ time: m[1]!, speaker: m[2]!.trim(), text: m[3]! });
    } else if (out.length > 0) {
      out[out.length - 1]!.text += `\n${raw}`; // a multi-line caption
    } else {
      out.push({ time: null, speaker: null, text: raw });
    }
  }
  return out;
}

function extractLists(summary: string): { rest: string; lists: Record<"actions" | "decisions" | "blockers", ListItem[]> } {
  const lists = { actions: [] as ListItem[], decisions: [] as ListItem[], blockers: [] as ListItem[] };
  const lines = summary.split("\n");
  const kept: string[] = [];
  let into: keyof typeof lists | null = null;
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const h = !inFence ? /^##[ \t]+(.+?)[ \t]*$/.exec(line) : null;
    if (h) {
      const title = h[1]!;
      into = (Object.keys(LIST_HEADINGS) as (keyof typeof lists)[]).find((k) => LIST_HEADINGS[k].some((t) => t.toLowerCase() === title.toLowerCase())) ?? null;
      if (into) continue; // the heading moves to its own card
    } else if (!inFence && /^#{1,6}[ \t]/.test(line)) {
      into = null;
    }
    if (into) {
      const b = /^[ \t]*[-*+][ \t]+(?:\[([ xX])\][ \t]+)?(.*\S)[ \t]*$/.exec(line);
      if (b && lists[into].length < 1000) lists[into].push({ text: b[2]!, done: b[1] === undefined ? null : b[1] !== " " });
      continue; // non-bullet lines inside a list section are dropped with the section
    }
    kept.push(line);
  }
  return { rest: kept.join("\n"), lists };
}

/** Distinct speakers in first-appearance order, with line counts, for the speaker filter. */
export function speakerCounts(items: readonly Utterance[]): { speaker: string; count: number }[] {
  const m = new Map<string, number>();
  for (const u of items) {
    const k = u.speaker ?? "";
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].map(([speaker, count]) => ({ speaker, count }));
}
