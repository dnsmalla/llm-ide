// Settings → Self-Heal (debug desktop builds only): the incidents the app recorded, most recent first, with Ignore,
// Refresh and Clear all. Proposing fixes is plan B (the notice says so). Text is shown as text, never run or sent.
import { useCallback, useEffect, useState } from "react";
import { useEnv } from "../context.tsx";
import { call } from "../core-api.ts";
import { Button, ErrorText } from "../ui.tsx";
import { SelfHealGroup } from "./NoticeSections.tsx";
import { SOURCE_TEXT, STATUS_TEXT, decodeIncidents, incidentSummary, type IncidentView } from "../self-heal-model.ts";

const BASE = "/kb/self-heal/incidents";

export default function SelfHealSection() {
  const { client } = useEnv();
  const [items, setItems] = useState<IncidentView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);
  const load = useCallback(async () => {
    try {
      setItems(decodeIncidents(await call(client, "GET", BASE)));
      setError(null);
    } catch {
      setError("Could not read the incidents. Check that the backend is running and you are signed in.");
    }
  }, [client]);
  useEffect(() => {
    void load();
  }, [load]);
  const act = async (method: "POST" | "DELETE", path: string) => {
    setBusy(true);
    try {
      await call(client, method, path);
      await load();
    } catch {
      setError("That did not work. Try again.");
    } finally {
      setBusy(false);
      setArmed(false);
    }
  };
  const busyRow = (i: IncidentView) => i.status === "fixing" || i.status === "proposed";

  return (
    <div className="st-stack">
      <SelfHealGroup />
      <div className="st-row">
        <Button disabled={busy} onClick={() => void load()}>Refresh</Button>
        {armed ? (
          <Button tone="danger" disabled={busy} onClick={() => void act("DELETE", BASE)}>Confirm: clear all</Button>
        ) : (
          <Button tone="danger" disabled={busy || !items || items.length === 0} onClick={() => setArmed(true)}>Clear all...</Button>
        )}
      </div>
      <ErrorText text={error} />
      <p className="st-hint" role="status">{items === null ? "Loading incidents..." : incidentSummary(items)}</p>
      {items && items.length > 0 ? (
        <ul className="st-stack" aria-label="Incidents">
          {items.map((i) => (
            <li key={i.id}>
              <p className="st-label">
                {SOURCE_TEXT[i.source]} · {i.category} · {STATUS_TEXT[i.status]}
                {i.environmental ? ` · environmental (${i.environmental})` : ""}
              </p>
              <p>{i.message}</p>
              <p className="st-hint">Seen {i.count} time{i.count === 1 ? "" : "s"}, last {new Date(i.lastSeen).toLocaleString()}</p>
              {i.stack.length > 0 ? (
                <details>
                  <summary>Stack</summary>
                  <pre>{i.stack.join("\n")}</pre>
                </details>
              ) : null}
              {i.status !== "ignored" && !busyRow(i) ? (
                <Button disabled={busy} onClick={() => void act("POST", `${BASE}/${i.id}/ignore`)}>Ignore</Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
