import { useCallback, useState } from "react";
import type { ProjectPaths } from "../host.ts";
import { PATHS_TEXT, projectError } from "../project-model.ts";
import { useEnv, useRefreshOnFocus } from "../context.tsx";
import { Button, ErrorText, NeedsHost } from "../ui.tsx";
import { PartialNote } from "./NoticeSections.tsx";

/**
 * The Mac's "Paths" project group: the folders the project uses on disk, with Show in Finder.
 * Read-only by design: the desktop's layout is fixed, and editing it is a Mac-only action for now.
 */
export default function PathsSection() {
  const { host } = useEnv();
  const [data, setData] = useState<ProjectPaths | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    host.projectPaths?.().then(
      (p) => { setData(p); setError(null); },
      (e) => { setData(null); setError(projectError(e)); },
    );
  }, [host]);
  useRefreshOnFocus(load);

  if (!host.projectPaths) return <NeedsHost what="The project folders" />;

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
      <p className="st-hint">{PATHS_TEXT.hint}</p>
      <ErrorText text={error} />
      {data === null && !error ? <p className="st-hint" role="status">Loading the project folders...</p> : null}
      {data ? (
        <>
          <p className="st-hint">{data.root}</p>
          <ul className="st-stack" aria-label="Project folders">
            {data.folders.map((f) => (
              <li key={f.name} className="st-row">
                <span className="st-pre st-grow">{f.name}</span>
                <span className="st-status" data-tone={f.exists ? "ok" : "warning"}>{f.exists ? PATHS_TEXT.present : PATHS_TEXT.missing}</span>
                {host.revealPath ? (
                  <Button disabled={busy !== null} onClick={() => void reveal(f.name)}>{PATHS_TEXT.reveal}</Button>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <PartialNote id="paths" />
    </div>
  );
}
