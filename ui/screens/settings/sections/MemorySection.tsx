import { useCallback, useState } from "react";
import type { ProjectMemory } from "../host.ts";
import { MEMORY_TEXT, bytesLabel, projectError } from "../project-model.ts";
import { useEnv, useRefreshOnFocus } from "../context.tsx";
import { shellBus } from "../../shell/bus";
import { Button, ErrorText, NeedsHost } from "../ui.tsx";

/**
 * The Mac's "Memory" project group: whether the knowledge graph was generated and the project's agent memory
 * files, read-only, with Show in Finder. Lists come from the host (the page never reads the disk).
 */
export default function MemorySection() {
  const { host } = useEnv();
  const [data, setData] = useState<ProjectMemory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    host.projectMemory?.().then(
      (m) => { setData(m); setError(null); },
      (e) => { setData(null); setError(projectError(e)); },
    );
  }, [host]);
  useRefreshOnFocus(load);

  if (!host.projectMemory) return <NeedsHost what="The project memory" />;

  const reveal = async (rel: string) => {
    if (!host.revealPath) return;
    setBusy(rel);
    try {
      await host.revealPath(rel);
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
              {data.graph && host.revealPath ? (
                <Button disabled={busy !== null} onClick={() => void reveal(data.graph!.path)}>{MEMORY_TEXT.reveal}</Button>
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
                    {host.revealPath ? (
                      <Button disabled={busy !== null} onClick={() => void reveal(f.path)}>{MEMORY_TEXT.reveal}</Button>
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
