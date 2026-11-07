// "Add from Library" in the chat composer: pick one note from the desktop notes folder and attach it as text.
// Read-only, through the same root-confined notes host the Library uses; the webview never sends an absolute path.
import { useEffect, useMemo, useState } from "react";
import type { NotesHost } from "../library/host.ts";
import { notesErrorText } from "../library/host.ts";
import { MAX_TEXT_CHARS_PER_FILE, TEXT_READ_BYTES } from "./attach/limits";

const PAGE = 200;
const baseName = (rel: string) => rel.split("/").pop() ?? rel;

export function LibraryNotePicker({ host, onPick, onClose }: { host: NotesHost; onPick(label: string, text: string): void; onClose(): void }) {
  const [entries, setEntries] = useState<Array<{ rel: string; placeholder: boolean }>>([]);
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    host.list(null, PAGE).then((p) => { if (live) setEntries(p.entries.map((e) => ({ rel: e.rel, placeholder: e.placeholder }))); },
      (e) => { if (live) setError(notesErrorText(e?.code ?? "io")); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [host]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return entries.filter((e) => !needle || e.rel.toLowerCase().includes(needle)).slice(0, 100);
  }, [entries, q]);

  const pick = async (e: { rel: string; placeholder: boolean }) => {
    if (e.placeholder) { setError("This note is in iCloud and is not downloaded."); return; }
    setBusy(true); setError(null);
    try {
      const r = await host.read(e.rel, 0, TEXT_READ_BYTES);
      onPick(baseName(e.rel), r.text.slice(0, MAX_TEXT_CHARS_PER_FILE));
      onClose();
    } catch (err) { setError(notesErrorText(((err as { code?: string })?.code ?? "io") as Parameters<typeof notesErrorText>[0])); } finally { setBusy(false); }
  };

  return (
    <div className="chat-popover chat-library-picker" role="dialog" aria-label="Add from Library" onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}>
      <div className="chat-library-head"><strong>Add from Library</strong><button type="button" className="chat-link-btn" onClick={onClose}>Close</button></div>
      <input autoFocus aria-label="Filter notes" placeholder="Filter notes" value={q} onChange={(ev) => setQ(ev.target.value)} />
      {loading ? <p className="chat-muted" role="status">Reading the notes folder…</p> : null}
      {error ? <p className="chat-error" role="alert">{error}</p> : null}
      {!loading && !rows.length && !error ? <p className="chat-muted">No notes match.</p> : null}
      <ul className="chat-library-list" aria-label="Notes">
        {rows.map((e) => <li key={e.rel}><button type="button" disabled={busy} onClick={() => void pick(e)}><span>{baseName(e.rel)}</span><small>{e.rel}</small></button></li>)}
      </ul>
    </div>
  );
}
