import { useCallback, useState } from "react";
import { call } from "../core-api.ts";
import { useEnv, useRefreshOnFocus } from "../context.tsx";
import { CONNECTIONS_TEXT, connectorBadges, decodeCatalog, sourcesError, type ConnectorEntry } from "../sources-model.ts";
import { Button, ErrorText } from "../ui.tsx";
import { PartialNote } from "./NoticeSections.tsx";

/**
 * The Mac's "Connections" group, catalog half: every connector the core knows, with Add/Remove from Library.
 * The core's own contract says selection is visibility only; credentials and fetching stay in the Library's
 * Connector panes, and the note under the list says so rather than pretending this card owns them.
 */
export default function ConnectionsSection() {
  const { client } = useEnv();
  const [rows, setRows] = useState<ConnectorEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    call(client, "GET", "/auth/me/connectors/catalog").then(
      (b) => { setRows(decodeCatalog(b)); setError(null); },
      (e) => { setRows([]); setError(sourcesError(e)); },
    );
  }, [client]);
  useRefreshOnFocus(load);

  const toggle = async (c: ConnectorEntry) => {
    setBusy(c.id);
    setError(null);
    try {
      if (c.selected) await call(client, "DELETE", `/auth/me/connectors/${encodeURIComponent(c.id)}`);
      else await call(client, "POST", "/auth/me/connectors/add", { id: c.id });
      load();
    } catch (e) {
      setError(sourcesError(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="st-stack">
      <p className="st-hint">{CONNECTIONS_TEXT.hint}</p>
      <ErrorText text={error} />
      <div className="st-row"><Button onClick={load}>Refresh catalog</Button></div>
      {rows === null ? (
        <p className="st-hint" role="status">Loading the catalog...</p>
      ) : rows.length === 0 ? (
        <p className="st-hint">{CONNECTIONS_TEXT.empty}</p>
      ) : (
        <ul className="st-stack" aria-label="Connector catalog">
          {rows.map((c) => (
            <li key={c.id} className="st-note">
              <div className="st-row">
                <strong>{c.name}</strong>
                {connectorBadges(c).map((b) => (
                  <span key={b} className="st-status" data-tone={b === "Selected" ? "ok" : b === "Hidden" ? undefined : "warning"}>{b}</span>
                ))}
              </div>
              {c.description ? <p className="st-hint">{c.description}</p> : null}
              <div className="st-row">
                <Button disabled={busy !== null} onClick={() => void toggle(c)}>
                  {c.selected ? CONNECTIONS_TEXT.remove : CONNECTIONS_TEXT.add}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <PartialNote id="connections" />
    </div>
  );
}
