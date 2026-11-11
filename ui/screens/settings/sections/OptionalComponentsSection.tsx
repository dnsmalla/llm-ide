import { useCallback, useEffect, useState } from "react";
import type { ComponentStatus } from "../host.ts";
import { MERMAID_TEXT, componentError, componentStateLabel, sizeLabel } from "../components-model.ts";
import { useEnv } from "../context.tsx";
import { Button, ErrorText, NeedsHost } from "../ui.tsx";
import TokenSavingSection from "./TokenSavingSection.tsx";

/**
 * The Mac's "Optional components" group: the on-demand Mermaid diagram renderer, with Install and Remove.
 * The host owns the download (a native dialog names the host, version and size), the pinned checksum and the
 * on-disk store; this card only asks and shows the result. It never fetches anything itself.
 */
export default function OptionalComponentsSection() {
  const { host } = useEnv();
  const [status, setStatus] = useState<ComponentStatus | null>(null);
  const [busy, setBusy] = useState<"install" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const can = Boolean(host.mermaidStatus && host.installMermaid && host.removeMermaid);

  const load = useCallback(() => {
    host.mermaidStatus?.().then(setStatus, (e) => setError(componentError(e)));
  }, [host]);
  useEffect(() => {
    if (can) load();
  }, [can, load]);

  if (!can) return <NeedsHost what="Installing optional components" />;

  const run = async (kind: "install" | "remove") => {
    setBusy(kind);
    setError(null);
    setNotice(null);
    try {
      const next = kind === "install" ? await host.installMermaid!() : await host.removeMermaid!();
      setStatus(next);
      const done = kind === "install" ? next.installed : !next.installed;
      setNotice(done ? (kind === "install" ? "Installed." : "Removed.") : MERMAID_TEXT.declined);
    } catch (e) {
      setError(componentError(e));
      // A failed action may still have changed nothing: re-read rather than guess.
      load();
    } finally {
      setBusy(null);
    }
  };

  const installed = status?.installed === true;
  return (
    <div className="st-stack">
      <div className="st-field">
        <span className="st-label">{MERMAID_TEXT.title}</span>
        <p>
          <span className="st-status" data-tone={installed ? "ok" : "warning"}>{componentStateLabel(status)}</span>
          {status ? <span className="st-hint"> · version {status.version} · {sizeLabel(status.sizeBytes)}</span> : null}
        </p>
        <p className="st-hint">{MERMAID_TEXT.hint}</p>
        <p className="st-hint">{status ? `Download host: ${status.host}` : "Reading the component state..."}</p>
        <div className="st-row">
          {installed ? (
            <Button tone="danger" disabled={busy !== null} onClick={() => void run("remove")}>
              {busy === "remove" ? "Removing..." : MERMAID_TEXT.remove}
            </Button>
          ) : (
            <Button tone="primary" disabled={busy !== null || !status} onClick={() => void run("install")}>
              {busy === "install" ? "Installing..." : MERMAID_TEXT.install}
            </Button>
          )}
          <Button disabled={busy !== null} onClick={load}>Refresh</Button>
        </div>
        {notice ? <p className="st-ok" role="status">{notice}</p> : null}
        <ErrorText text={error} />
      </div>
      <div className="st-stack">
        <span className="st-label">Token Saving</span>
        <TokenSavingSection />
      </div>
    </div>
  );
}
