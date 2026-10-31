// The note viewer: loads the selected note through bounded host reads (cancelled when the selection
// changes or the viewer unmounts), then shows metadata, the frontmatter, and the body as a meeting
// detail, safe markdown, or plain text. Read-only.
import { useMemo, useState, type ReactNode } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import { NotesError, notesErrorText, toNotesError, type NotesErrorCode, type NotesHost } from "./host.ts";
import { describeNote, loadNote, type LoadedNote } from "./note-view.ts";
import type { NoteRecord } from "./notes-model.ts";
import { MeetingDetail } from "./MeetingDetail";
import { MarkdownView, type LinkHandlers } from "./MarkdownView";
import { useAbortable } from "./use-library.ts";

type Load = { phase: "loading" } | { phase: "ready"; note: LoadedNote } | { phase: "error"; code: NotesErrorCode };

export interface NoteViewerProps extends LinkHandlers {
  host: NotesHost;
  rel: string;
  record: NoteRecord | undefined;
  /** Bump to reload the same note (the list refreshed). */
  reloadKey?: number;
}

/** State of one note load, cancelled on change or unmount. */
export function useNoteLoad(host: NotesHost, rel: string, reloadKey: number | undefined): Load {
  const [load, setLoad] = useState<Load>({ phase: "loading" });
  useAbortable(
    (signal) => {
      setLoad({ phase: "loading" });
      loadNote(host, rel, signal).then(
        (note) => {
          if (!signal.aborted) setLoad({ phase: "ready", note });
        },
        (e: unknown) => {
          if (!signal.aborted) setLoad({ phase: "error", code: e instanceof NotesError ? e.code : toNotesError(e).code });
        },
      );
    },
    [host, rel, reloadKey],
  );
  return load;
}

export function NoteViewer({ host, rel, record, reloadKey, onOpenExternal, onOpenNote }: NoteViewerProps): ReactNode {
  const load = useNoteLoad(host, rel, reloadKey);
  const handlers = useMemo<LinkHandlers>(() => ({ onOpenExternal, onOpenNote }), [onOpenExternal, onOpenNote]);
  const view = useMemo(() => (load.phase === "ready" ? describeNote(record, load.note) : null), [load, record]);
  const [showFm, setShowFm] = useState(false);

  if (load.phase === "loading") {
    return (
      <article className="lib-viewer" aria-busy="true" aria-label="Loading note">
        <p className="lib-muted" role="status">
          Loading…
        </p>
      </article>
    );
  }
  if (load.phase === "error" || !view) {
    const code = load.phase === "error" ? load.code : "io";
    return (
      <article className="lib-viewer">
        <StatusBanner severity={code === "not_downloaded" ? "warning" : "error"} message={notesErrorText(code)} />
        <p className="lib-muted lib-path">{rel}</p>
      </article>
    );
  }
  return (
    <article className="lib-viewer" aria-label={view.title}>
      <header className="lib-viewer-head">
        <h2 className="lib-viewer-title">{view.title}</h2>
        <p className="lib-muted lib-path" title={rel}>
          {rel}
        </p>
        {view.meta.length > 0 && (
          <dl className="lib-meta" aria-label="Note metadata">
            {view.meta.map((m) => (
              <div key={m.label} className="lib-meta-item">
                <dt>{m.label}</dt>
                <dd>{m.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {view.hasFrontmatter && view.frontmatter.length > 0 && (
          <div>
            <button type="button" className="lib-link-btn" aria-expanded={showFm} onClick={() => setShowFm((v) => !v)}>
              {showFm ? "Hide frontmatter" : `Show frontmatter (${view.frontmatter.length})`}
            </button>
            {showFm && (
              <table className="lib-fm" aria-label="Frontmatter">
                <tbody>
                  {view.frontmatter.map((r) => (
                    <tr key={r.key}>
                      <th scope="row">{r.key}</th>
                      <td>{r.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </header>
      {view.notices.map((n) => (
        <StatusBanner key={n} severity="warning" message={n} />
      ))}
      {view.kind === "meeting" ? (
        <MeetingDetail view={view} baseRel={rel} handlers={handlers} />
      ) : view.kind === "text" ? (
        <pre className="lib-plain" tabIndex={0}>
          {view.body}
        </pre>
      ) : (
        <MarkdownView text={view.body} baseRel={rel} {...handlers} />
      )}
    </article>
  );
}
