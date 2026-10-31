// Meeting detail (read-only): summary, action / decision / blocker lists and the transcript with
// speakers. The transcript renders progressively (a 50,000-line transcript never mounts at once).
import { useMemo, useState, type ReactNode } from "react";
import { Chip } from "@llmide/ui-kit";
import type { MeetingBody, ListItem } from "./meeting.ts";
import { speakerCounts } from "./meeting.ts";
import { MarkdownView, type LinkHandlers } from "./MarkdownView";
import type { NoteView } from "./note-view.ts";

const PAGE = 200;

function Items({ title, items }: { title: string; items: readonly ListItem[] }): ReactNode {
  if (items.length === 0) return null;
  return (
    <section className="lib-card" aria-label={`${title} (${items.length})`}>
      <h3>
        {title} <span className="lib-count">{items.length}</span>
      </h3>
      <ul className="lib-items">
        {items.map((it, i) => (
          <li key={i}>
            {it.done !== null && <input type="checkbox" checked={it.done} readOnly disabled aria-label={it.done ? "Done" : "Not done"} />}
            <span>{it.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Transcript({ meeting, initialCount = PAGE }: { meeting: MeetingBody; initialCount?: number }): ReactNode {
  const [speaker, setSpeaker] = useState<string | null>(null);
  const [count, setCount] = useState(initialCount);
  const speakers = useMemo(() => speakerCounts(meeting.transcript), [meeting.transcript]);
  const lines = useMemo(() => (speaker === null ? meeting.transcript : meeting.transcript.filter((u) => (u.speaker ?? "") === speaker)), [meeting.transcript, speaker]);
  if (!meeting.hasTranscript) return null;
  return (
    <section className="lib-card" aria-label="Transcript">
      <h3>
        Transcript <span className="lib-count">{meeting.transcript.length}</span>
      </h3>
      {speakers.length > 1 && (
        <div className="lib-chips" role="group" aria-label="Filter by speaker">
          <Chip label="All" active={speaker === null} compact onClick={() => { setSpeaker(null); setCount(initialCount); }} />
          {speakers.slice(0, 12).map((s) => (
            <Chip key={s.speaker} label={`${s.speaker || "Unknown"} ${s.count}`} active={speaker === s.speaker} compact onClick={() => { setSpeaker(s.speaker); setCount(initialCount); }} />
          ))}
        </div>
      )}
      {lines.length === 0 ? (
        <p className="lib-muted">No transcript lines.</p>
      ) : (
        <ol className="lib-transcript" aria-label="Transcript lines">
          {lines.slice(0, count).map((u, i) => (
            <li key={i}>
              {u.time && <time className="lib-time">{u.time}</time>}
              {u.speaker && <strong className="lib-speaker">{u.speaker}</strong>}
              <span className="lib-utterance">{u.text}</span>
            </li>
          ))}
        </ol>
      )}
      {lines.length > count && (
        <button type="button" className="lib-btn" onClick={() => setCount((c) => c + PAGE * 5)}>
          Show {Math.min(PAGE * 5, lines.length - count)} more lines ({lines.length - count} left)
        </button>
      )}
    </section>
  );
}

export function MeetingDetail({ view, baseRel, handlers, initialCount }: { view: NoteView; baseRel: string; handlers: LinkHandlers; initialCount?: number }): ReactNode {
  const m = view.meeting;
  if (!m) return null;
  return (
    <div className="lib-meeting">
      {view.gist && (
        <section className="lib-card" aria-label="Gist">
          <h3>Gist</h3>
          <p>{view.gist}</p>
        </section>
      )}
      {view.tldr.length > 0 && (
        <section className="lib-card" aria-label="TL;DR">
          <h3>TL;DR</h3>
          <ul className="lib-items">
            {view.tldr.map((t, i) => (
              <li key={i}>
                <span>{t}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <Items title="Actions" items={m.actions} />
      <Items title="Decisions" items={m.decisions} />
      <Items title="Blockers" items={m.blockers} />
      {m.summaryMarkdown !== "" && (
        <details className="lib-card" open={!view.gist && view.tldr.length === 0}>
          <summary>Full notes</summary>
          <MarkdownView text={m.summaryMarkdown} baseRel={baseRel} {...handlers} />
        </details>
      )}
      {!m.hasTranscript && m.summaryMarkdown === "" && <p className="lib-muted">This meeting has no summary or transcript yet.</p>}
      <Transcript meeting={m} initialCount={initialCount} />
    </div>
  );
}
