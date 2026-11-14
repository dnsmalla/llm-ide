// The remote workspace: a project file tree, one text buffer and Save. All file bytes stay on the host; this screen
// sends intents and receives the one file it opens.
import { useEffect, useMemo, useState } from "react";
import type { SectionProps } from "../shell/registry.ts";
import { statFile, writeFile } from "./api.ts";
import { Changes } from "./Changes.tsx";
import { Terminal } from "./Terminal.tsx";
import { conflictText, dirtyOf, isTextLike, parentOf, saveAllowed } from "./model.ts";
import "./workspace.css";

interface Entry { name: string; path: string; kind: "file" | "dir"; size?: number }

export function WorkspaceScreen({ ctx }: SectionProps) {
  const link = ctx.session.connection;
  const projectId = ctx.projects.selectedId;
  const [dir, setDir] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [path, setPath] = useState<string | null>(null);
  const [saved, setSaved] = useState("");
  const [buffer, setBuffer] = useState("");
  const [hash, setHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const dirty = useMemo(() => dirtyOf(buffer, saved), [buffer, saved]);
  const [mode, setMode] = useState<"files" | "changes" | "terminal">("files");

  // Switching projects must not leave the previous project's path and hash in the editor.
  useEffect(() => {
    setDir(""); setEntries([]); setPath(null); setSaved(""); setBuffer(""); setHash(null); setError(null);
  }, [projectId]);

  useEffect(() => {
    if (!projectId || !link.capabilities.has("read")) return;
    let live = true;
    setError(null);
    void link.send("files.list", { projectId, path: dir }).done
      .then((r) => { if (live) setEntries(r.entries as Entry[]); })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [link, projectId, dir]);

  const openPath = async (file: string) => {
    if (!projectId) return;
    if (!isTextLike(file)) { setError("That file is not text. Phase 1 opens text files only."); return; }
    setError(null);
    try {
      const [text, stat] = await Promise.all([
        link.send("files.read", { projectId, path: file, maxBytes: 262144 }).done,
        statFile(link, projectId, file),
      ]);
      setPath(file); setSaved(text.text); setBuffer(text.text); setHash(stat.hash);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const open = async (entry: Entry) => {
    if (entry.kind === "dir") { setDir(entry.path); return; }
    await openPath(entry.path);
  };

  const save = async () => {
    if (!projectId || !path || !saveAllowed({ dirty, saving })) return;
    setSaving(true); setError(null);
    try {
      const out = await writeFile(link, projectId, path, buffer, hash, false, false);
      setSaved(buffer); setHash(out.hash);
    } catch (e) {
      const code = e && typeof e === "object" && "code" in e ? String((e as { code?: unknown }).code) : "";
      setError(code === "conflict" ? conflictText("another writer") : e instanceof Error ? e.message : String(e));
    } finally { setSaving(false); }
  };

  if (!projectId) return <div className="web-page ws-empty"><p>Select a project to open its workspace.</p></div>;

  return (
    <div className={`ws-root${mode !== "files" ? " ws-single" : ""}`}>
      {mode === "changes" ? <Changes link={link} projectId={projectId} onClose={() => setMode("files")} onOpen={(file) => { setMode("files"); void openPath(file); }} /> : mode === "terminal" ? <Terminal link={link} projectId={projectId} onClose={() => setMode("files")} /> : <>
      <aside className="ws-files" aria-label="Project files">
        <header className="ws-files-head">
          <button type="button" className="ws-up" disabled={dir === ""} onClick={() => setDir(parentOf(dir))}>Up</button>
          <code>/{dir}</code>
          <button type="button" onClick={() => setMode("changes")}>Changes</button>
          <button type="button" onClick={() => setMode("terminal")}>Terminal</button>
        </header>
        <ul>
          {entries.map((e) => (
            <li key={e.path}>
              <button type="button" data-kind={e.kind} className={e.path === path ? "ws-on" : undefined} onClick={() => void open(e)}>
                {e.kind === "dir" ? "▸ " : ""}{e.name}
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <section className="ws-editor">
        {path === null ? <p className="ws-hint">Choose a file on the left. Header text only in Phase 1.</p> : (
          <>
            <header className="ws-editor-head">
              <code>{path}</code>
              <span>{dirty ? "unsaved" : "saved"}</span>
              <button type="button" disabled={!saveAllowed({ dirty, saving })} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</button>
            </header>
            {error ? <p className="ws-error" role="alert">{error}</p> : null}
            <textarea value={buffer} spellCheck={false} onChange={(e) => setBuffer(e.target.value)} aria-label={`Edit ${path}`} />
          </>
        )}
        {path === null && error ? <p className="ws-error" role="alert">{error}</p> : null}
      </section>
      </>}
    </div>
  );
}
