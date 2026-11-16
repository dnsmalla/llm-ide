import { useCallback, useState } from "react";
import type { ProjectMemory } from "../host.ts";
import { MEMORY_TEXT, PATHS_TEXT, bytesLabel, pathsIsNoticeOnly, projectError } from "../project-model.ts";
import { useEnv, useRefreshOnFocus } from "../context.tsx";
import { shellBus } from "../../shell/bus";
import { inSshMode } from "../../shell/host.ts";
import { COPY_SERVER_PATH_LABEL, fileManagerActionFor } from "../../shell/server-path.ts";
import { Button, ErrorText, NeedsHost } from "../ui.tsx";

/**
 * The Mac's "Memory" project group: whether the knowledge graph was generated and the project's agent memory
 * files, read-only, with Show in Finder. Lists come from the host (the page never reads the disk).
 */
export default function MemorySection({ initial }: { initial?: { data: ProjectMemory | null; plainFolder: boolean } } = {}) {
  const { host } = useEnv();
  // NOTE: `initial` seeds the first render for tests (server rendering runs no effects); the app never passes it.
  const [data, setData] = useState<ProjectMemory | null>(initial?.data ?? null);
  // The memory reply has no isProject; the Paths reply does, so a plain server folder is read from there.
  const [plainFolder, setPlainFolder] = useState(initial?.plainFolder ?? false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    host.projectMemory?.().then(
      (m) => { setData(m); setError(null); },
      (e) => { setData(null); setError(projectError(e)); },
    );
    host.projectPaths?.().then(
      (p) => setPlainFolder(pathsIsNoticeOnly(p, true)),
      () => setPlainFolder(false),
    );
  }, [host]);
  useRefreshOnFocus(load);

  if (!host.projectMemory) return <NeedsHost what="The project memory" />;
  // ssh mode on a plain server folder: no memory exists there, so the card is the notice alone (as in Paths).
  if (plainFolder && inSshMode()) return <div className="st-stack"><p className="st-hint" role="status">{PATHS_TEXT.plainFolder}</p></div>;

  // ssh mode: the memory files are on the server, so the button copies the server path under the project root.
  const ssh = inSshMode();
  const revealPath = host.revealPath;
  const action = fileManagerActionFor(ssh, data?.root ?? null, revealPath ? (rel) => revealPath.call(host, rel) : undefined);
  const revealLabel = ssh ? COPY_SERVER_PATH_LABEL : MEMORY_TEXT.reveal;

  const reveal = async (rel: string) => {
    if (!action) return;
    setBusy(rel);
    try {
      await action.run(rel);
    } catch (e) {
      setError(projectError(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="st-stack">
      <p className="st-hint">{MEMORY_TEXT.hint}</p>
      <div className="st-row"><Button onClick={() => {
        shellBus.publish({ type: "goto-section", section: "chat" });
        shellBus.publish({ type: "ask-chat", prompt: "Summarize this project's memory and code graph for a new teammate. Use the memory and graph tools. Name the main areas, the files that connect them, and what is missing or stale." });
      }}>Ask Chat about memory</Button></div>
      <ErrorText text={error} />
      {data === null && !error ? <p className="st-hint" role="status">Loading project memory...</p> : null}
      {data ? (
        <>
          <div className="st-stack">
            <span className="st-label">{MEMORY_TEXT.graph}</span>
            <div className="st-row">
              <span className="st-status" data-tone={data.graph ? "ok" : "warning"}>
                {data.graph ? `${MEMORY_TEXT.generated} · ${bytesLabel(data.graph.sizeBytes)}` : MEMORY_TEXT.notGenerated}
              </span>
              {data.graph && action ? (
                <Button disabled={busy !== null} onClick={() => void reveal(data.graph!.path)}>{revealLabel}</Button>
              ) : null}
            </div>
          </div>
          <div className="st-stack">
            <span className="st-label">{MEMORY_TEXT.files}</span>
            {data.files.length === 0 ? (
              <p className="st-hint">{MEMORY_TEXT.empty}</p>
            ) : (
              <ul className="st-stack" aria-label="Memory files">
                {data.files.map((f) => (
                  <li key={f.path} className="st-row">
                    <span className="st-pre st-grow">{f.name}</span>
                    <span className="st-hint">{bytesLabel(f.sizeBytes)}</span>
                    {action ? (
                      <Button disabled={busy !== null} onClick={() => void reveal(f.path)}>{revealLabel}</Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
