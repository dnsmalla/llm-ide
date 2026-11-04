import { useCallback, useEffect, useState } from "react";
import { shellBus } from "../../shell/bus";
import type { ProjectPaths } from "../host.ts";
import { PATHS_TEXT, folderNote, projectError, syncProviderFor } from "../project-model.ts";
import { useEnv, useRefreshOnFocus } from "../context.tsx";
import { createHostFs } from "../../explorer/fs.ts";
import { projectIdFor } from "../../docgen/docs-api.ts";
import { decodeExportBundle, runProjectExport } from "../export-project.ts";
import { Button, ErrorText, NeedsHost } from "../ui.tsx";
import { PartialNote } from "./NoticeSections.tsx";

/**
 * The Mac's "Paths" project group: the project root and canonical folders with their explanations and Show in
 * Finder, the notes folder's sync badge, Rebuild missing folders, and a link to Library for the index rebuild.
 * The layout itself stays read-only in the desktop (the Mac edits it with a native dialog).
 */
export default function PathsSection() {
  const { host, client } = useEnv();
  const [data, setData] = useState<ProjectPaths | null>(null);
  const [notes, setNotes] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const [rebuilt, setRebuilt] = useState<string | null>(null);
  const [exporting, setExporting] = useState<"data" | "plans" | null>(null);
  const [exportNotice, setExportNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    host.projectPaths?.().then(
      (p) => { setData(p); setError(null); },
      (e) => { setData(null); setError(projectError(e)); },
    );
    host.notesFolderPath?.().then((p) => setNotes(p), () => setNotes(null));
  }, [host]);
  useRefreshOnFocus(load);
  useEffect(load, [load]);

  if (!host.projectPaths) return <NeedsHost what="The project folders" />;

  const reveal = async (rel: string) => {
    if (!host.revealPath) return;
    setBusy(rel || "__root__");
    try {
      await host.revealPath(rel);
    } catch (e) {
      setError(projectError(e));
    } finally {
      setBusy(null);
    }
  };

  const rebuild = async () => {
    if (!host.rebuildProjectFolders) return;
    setRebuilding(true);
    setError(null);
    setRebuilt(null);
    try {
      await host.rebuildProjectFolders();
      setRebuilt("Missing folders re-created. Existing files were left untouched.");
      load();
    } catch (e) {
      setError(projectError(e));
    } finally {
      setRebuilding(false);
    }
  };

  const exportProject = async (kind: "data" | "plans") => {
    if (!data) return;
    setExporting(kind);
    setError(null);
    setExportNotice(null);
    try {
      const id = await projectIdFor(data.root);
      const raw = await client.request("GET", `/kb/project/${encodeURIComponent(id)}/export`);
      const bundle = decodeExportBundle(raw);
      if (!bundle) throw new Error("The core returned an export bundle this app could not read.");
      const fs = createHostFs();
      const r = await runProjectExport({ bundle, projectId: id, fs, nowIso: new Date().toISOString(), plansOnly: kind === "plans" });
      setExportNotice(kind === "plans"
        ? r.plans === 0 ? "No plans to export." : `Exported ${r.plans} plan${r.plans === 1 ? "" : "s"} to llm-doc/plans.`
        : `Exported ${r.meetings} meeting${r.meetings === 1 ? "" : "s"} and ${r.plans} plan${r.plans === 1 ? "" : "s"}.${r.plansWriteFailed ? " The plans side-export failed; the meetings were written." : ""}`);
    } catch (e) {
      setError(projectError(e));
    } finally {
      setExporting(null);
    }
  };

  const sync = notes ? syncProviderFor(notes) : null;
  const notesInProject = Boolean(data && notes && notes.startsWith(`${data.root.replace(/\/+$/, "")}/`));
  const notesRel = data && notesInProject && notes ? notes.slice(data.root.replace(/\/+$/, "").length + 1) : null;

  return (
    <div className="st-stack">
      <p className="st-hint">{PATHS_TEXT.hint}</p>
      <ErrorText text={error} />
      {data === null && !error ? <p className="st-hint" role="status">Loading the project folders...</p> : null}
      {data ? (
        <>
          <div className="st-row">
            <span className="st-label">Project root</span>
            <span className="st-pre st-grow" title={data.root}>{data.root}</span>
            {host.revealPath ? <Button disabled={busy !== null} onClick={() => void reveal("")}>Reveal in Finder</Button> : null}
          </div>
          <ul className="st-stack" aria-label="Project folders">
            {data.folders.map((f) => (
              <li key={f.name} className="st-row" title={folderNote(f.name) ?? undefined}>
                <span className="st-pre st-grow">{f.name}</span>
                {folderNote(f.name) ? <span className="st-hint">{folderNote(f.name)}</span> : null}
                <span className="st-status" data-tone={f.exists ? "ok" : "warning"}>{f.exists ? PATHS_TEXT.present : PATHS_TEXT.missing}</span>
                {host.revealPath ? (
                  <Button disabled={busy !== null || !f.exists} onClick={() => void reveal(f.name)}>{PATHS_TEXT.reveal}</Button>
                ) : null}
              </li>
            ))}
          </ul>

          <div className="st-stack">
            <span className="st-label">Notes folder</span>
            {notes ? (
              <div className="st-row">
                <span className="st-pre st-grow" title={notes}>{notes}</span>
                {sync ? <span className="st-status" data-tone="ok">{sync}</span> : null}
                {notesInProject && host.revealPath && notesRel ? <Button disabled={busy !== null} onClick={() => void reveal(notesRel)}>Reveal</Button> : null}
                <Button onClick={() => shellBus.publish({ type: "goto-section", section: "library" })}>Open Library</Button>
              </div>
            ) : <p className="st-hint">No notes folder is configured in this project.</p>}
            <p className="st-hint">The search index is rebuilt from Library (its notes list owns the records).</p>
          </div>

          {host.rebuildProjectFolders ? (
            <div className="st-row">
              <Button disabled={rebuilding} onClick={() => void rebuild()}>{rebuilding ? "Rebuilding…" : "Rebuild missing folders"}</Button>
              <span className="st-hint">Re-creates missing canonical folders and seed files; never overwrites existing ones.</span>
            </div>
          ) : null}
          <div className="st-row">
            <Button disabled={exporting !== null} onClick={() => void exportProject("data")}>{exporting === "data" ? "Exporting…" : "Export Project Data"}</Button>
            <Button disabled={exporting !== null} onClick={() => void exportProject("plans")}>{exporting === "plans" ? "Exporting…" : "Export Plans"}</Button>
            <span className="st-hint">Writes the canonical source/meetings, llm-doc/plans, README badge and system/sync.json. Plans-only writes llm-doc/plans.</span>
          </div>
          {exportNotice ? <p className="st-ok" role="status">{exportNotice}</p> : null}
          {rebuilt ? <p className="st-ok" role="status">{rebuilt}</p> : null}
        </>
      ) : null}
      <PartialNote id="paths" />
    </div>
  );
}
