// The Calendar card of Easy setup: a list of iCal feeds (up to MAX_FEEDS), an add form, and per feed a status chip,
// Sync, window options and a typed-confirm delete. Typed against `ical-api.ts` (the core's multi-feed routes).
//
// Rules: the secret address is a write-only password input, cleared the moment it is sent, never echoed, logged or
// stored; after saving only the calendar id prefix and the host are shown; names and every core string render as
// text only. The core indexes the events itself, so this card writes no notes.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import { Dialog } from "../../write/Dialog";
import * as A from "./ical-api.ts";
import * as E from "./easy.ts";
import { GuideCard } from "./GuideCard";
import { Field, formatWhen } from "./shared";

interface IcalTask {
  busy: boolean;
  error: A.IcalError | null;
  run: <R>(fn: (signal: AbortSignal) => Promise<R>) => Promise<R | undefined>;
  stop: () => void;
  clear: () => void;
}

/** One cancellable operation at a time, with errors mapped to `IcalError`. */
function useIcalTask(): IcalTask {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<A.IcalError | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const run = useCallback(async <R,>(fn: (signal: AbortSignal) => Promise<R>): Promise<R | undefined> => {
    if (abort.current) return undefined;
    const ac = new AbortController();
    abort.current = ac;
    setBusy(true);
    setError(null);
    try {
      return await fn(ac.signal);
    } catch (e) {
      const err = A.mapIcalThrown(e, ac.signal);
      if (err.code !== "cancelled") setError(err);
      return undefined;
    } finally {
      abort.current = null;
      setBusy(false);
    }
  }, []);
  return { busy, error, run, stop: () => abort.current?.abort(), clear: () => setError(null) };
}

// ---- add form --------------------------------------------------------------------------------

export function AddFeedForm({ count, busy, onAdd }: { count: number; busy: boolean; onAdd: (name: string, url: string) => void }): ReactNode {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const full = count >= A.MAX_FEEDS;
  const nameCheck = name === "" ? null : A.validateFeedName(name);
  const urlCheck = url === "" ? null : A.validateIcalUrl(url);
  const ready = nameCheck?.ok === true && urlCheck?.ok === true;
  const submit = (): void => {
    const n = A.validateFeedName(name);
    const u = A.validateIcalUrl(url);
    if (!n.ok || !u.ok) return;
    // The secret address leaves this component's state at once; the request is built from `u.url` synchronously.
    setUrl("");
    setName("");
    onAdd(n.name, u.url);
  };
  return (
    <div className="lib-form" aria-label="Add a calendar">
      {full && <StatusBanner severity="info" message={A.icalErrorText("too_many")} />}
      <Field label="Name (only for you; shown in the list)" error={nameCheck && !nameCheck.ok ? nameCheck.problem : undefined}>
        <input type="text" autoComplete="off" spellCheck={false} maxLength={400} value={name} onChange={(e) => setName(e.target.value)} aria-invalid={nameCheck !== null && !nameCheck.ok} disabled={full} />
      </Field>
      <Field label="Secret address in iCal format (sent once to the core's vault, never shown again)" error={urlCheck && !urlCheck.ok ? urlCheck.problem : undefined}>
        <input type="password" autoComplete="off" spellCheck={false} value={url} onChange={(e) => setUrl(e.target.value)} aria-invalid={urlCheck !== null && !urlCheck.ok} placeholder="https://calendar.google.com/calendar/ical/…/basic.ics" disabled={full} />
      </Field>
      {urlCheck && urlCheck.ok && urlCheck.kind === "public" && (
        <span className="lib-muted" role="status">
          This is the public address of a public calendar; it works, but it is not the secret address.
        </span>
      )}
      <button type="button" className="lib-btn lib-btn-primary" onClick={submit} disabled={busy || full || !ready}>
        Add calendar
      </button>
    </div>
  );
}

// ---- per-feed window options -----------------------------------------------------------------

export function FeedOptionsEditor({ feed, busy, onSave }: { feed: A.Feed; busy: boolean; onSave: (o: A.FeedOptions) => void }): ReactNode {
  const [back, setBack] = useState(String(feed.options.daysBack));
  const [ahead, setAhead] = useState(String(feed.options.daysAhead));
  const check = A.validateOptions(back, ahead);
  const changed = check.ok && (check.options.daysBack !== feed.options.daysBack || check.options.daysAhead !== feed.options.daysAhead);
  return (
    <fieldset className="lib-form" aria-label={`Window for ${feed.name}`}>
      <legend>Window</legend>
      <Field label={`Days back (0 to ${A.DAYS_BACK_MAX})`}>
        <input type="text" inputMode="numeric" autoComplete="off" value={back} onChange={(e) => setBack(e.target.value)} aria-invalid={!check.ok} />
      </Field>
      <Field label={`Days ahead (0 to ${A.DAYS_AHEAD_MAX})`}>
        <input type="text" inputMode="numeric" autoComplete="off" value={ahead} onChange={(e) => setAhead(e.target.value)} aria-invalid={!check.ok} />
      </Field>
      {!check.ok && (
        <span className="lib-muted" role="alert">
          {check.problem}
        </span>
      )}
      <span className="lib-muted">{A.OPTIONS_CHANGED_NOTE}</span>
      <button type="button" className="lib-btn" disabled={busy || !changed} onClick={() => check.ok && onSave(check.options)}>
        Save window
      </button>
    </fieldset>
  );
}

// ---- delete ----------------------------------------------------------------------------------

export function DeleteFeedDialog({ feed, busy, error, onConfirm, onClose }: { feed: A.Feed; busy: boolean; error: A.IcalError | null; onConfirm: () => void; onClose: () => void }): ReactNode {
  const [typed, setTyped] = useState("");
  const ok = typed.trim().toLowerCase() === A.DELETE_WORD;
  return (
    <Dialog title="Delete this calendar?" onClose={onClose} role="alertdialog" busy={busy}>
      <div className="lib-form">
        <p>{A.deleteExplanation(feed.name)}</p>
        <label className="lib-field">
          <span>Type {A.DELETE_WORD} to confirm</span>
          <input type="text" autoComplete="off" spellCheck={false} value={typed} onChange={(e) => setTyped(e.target.value)} data-autofocus="true" />
        </label>
        {error && <StatusBanner severity="error" message={A.icalErrorLine(error)} />}
        <div className="lib-modal-actions">
          <button type="button" className="lib-btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="lib-btn lib-btn-danger" onClick={onConfirm} disabled={busy || !ok}>
            Delete
          </button>
        </div>
      </div>
    </Dialog>
  );
}

// ---- feed list -------------------------------------------------------------------------------

export function FeedRow({ feed, busy, syncing, result, onSync, onStop, onSaveOptions, onDelete }: { feed: A.Feed; busy: boolean; syncing: boolean; result: A.FeedSync | null; onSync: () => void; onStop: () => void; onSaveOptions: (o: A.FeedOptions) => void; onDelete: () => void }): ReactNode {
  const when = formatWhen(feed.lastRunAt);
  const lastError = feed.status === "idle" ? null : A.lastErrorText(feed.lastError);
  return (
    <li aria-label={`Calendar ${feed.name}`} style={{ flexDirection: "column" }}>
      <div className="lib-editor-bar">
        <strong>{feed.name}</strong>
        <span className="lib-badge" data-state={feed.status === "idle" ? "ok" : "off"}>
          {A.statusLabel(feed.status)}
        </span>
        <span className="lib-muted lib-path">
          {feed.calendarIdPrefix ? `${feed.calendarIdPrefix}… on ` : ""}
          {feed.host}
        </span>
      </div>
      <p className="lib-muted">
        {when ? `Last sync ${when}.` : "Not synced yet."} Window: {feed.options.daysBack} days back, {feed.options.daysAhead} days ahead. Indexed in the core.
      </p>
      {feed.status === "revoked" && <StatusBanner severity="warning" message={A.icalErrorText("revoked")} />}
      {feed.status === "error" && lastError && <StatusBanner severity="error" message={lastError} />}
      {syncing && (
        <span role="status" className="lib-muted">
          Syncing… the core is reading the calendar.
        </span>
      )}
      {result && !syncing && (
        <div role="status">
          <p>{A.syncMessage(result)}</p>
          {result.warnings.length > 0 && (
            <ul aria-label="Sync warnings">
              {result.warnings.map((w) => (
                <li key={w} className="lib-muted">
                  {A.warningText(w)}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="lib-editor-bar">
        <button type="button" className="lib-btn lib-btn-primary" disabled={busy} onClick={onSync} aria-label={`Sync ${feed.name}`}>
          Sync
        </button>
        {syncing && (
          <button type="button" className="lib-link-btn" onClick={onStop}>
            Stop
          </button>
        )}
        <button type="button" className="lib-btn lib-btn-danger" disabled={busy} onClick={onDelete} aria-label={`Delete ${feed.name}`}>
          Delete
        </button>
      </div>
      <FeedOptionsEditor key={`${feed.sourceId}:${feed.options.daysBack}:${feed.options.daysAhead}`} feed={feed} busy={busy} onSave={onSaveOptions} />
    </li>
  );
}

// ---- card ------------------------------------------------------------------------------------

export function IcalCard({ api }: { api: A.IcalApi }): ReactNode {
  const [feeds, setFeeds] = useState<A.Feed[] | null>(null);
  const [loadErr, setLoadErr] = useState<A.IcalError | null>(null);
  const [n, setN] = useState(0);
  const [info, setInfo] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, A.FeedSync>>({});
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<A.Feed | null>(null);
  const task = useIcalTask();
  useEffect(() => {
    const ac = new AbortController();
    api.list(ac.signal).then(
      (f) => {
        setFeeds(f);
        setLoadErr(null);
      },
      (e) => !ac.signal.aborted && setLoadErr(A.mapIcalThrown(e, ac.signal)),
    );
    return () => ac.abort();
  }, [api, n]);
  const reload = (): void => setN((x) => x + 1);
  const unavailable = loadErr?.code === "core_update";
  const badge = unavailable ? "Available after the core update" : feeds === null ? (loadErr ? "Not available" : "Checking") : feeds.length === 0 ? "Not set up" : `${feeds.length} of ${A.MAX_FEEDS} calendars`;

  const add = (name: string, url: string): void => {
    void task.run(async (signal) => {
      const r = await api.add(name, url, signal);
      setInfo(`Added ${r.name}${r.calendarIdPrefix ? ` (${r.calendarIdPrefix}…` : " ("}on ${r.host}). The address is stored in the core's vault and is not shown again. Press Sync to index its events.`);
      reload();
    });
  };
  const sync = (f: A.Feed): void => {
    setSyncingId(f.sourceId);
    void task
      .run(async (signal) => {
        const r = await api.sync(f.sourceId, signal);
        setResults((m) => ({ ...m, [f.sourceId]: r }));
        reload();
      })
      .finally(() => setSyncingId(null));
  };
  const saveOptions = (f: A.Feed, o: A.FeedOptions): void => {
    void task.run(async (signal) => {
      const saved = await api.setOptions(f.sourceId, o, signal);
      setResults((m) => {
        const { [f.sourceId]: _drop, ...rest } = m;
        return rest;
      });
      setInfo(`Window saved for ${f.name}: ${saved.daysBack} days back, ${saved.daysAhead} days ahead. ${A.OPTIONS_CHANGED_NOTE}`);
      reload();
    });
  };
  const confirmDelete = (): void => {
    const f = deleting;
    if (!f) return;
    void task.run(async (signal) => {
      const r = await api.remove(f.sourceId, signal);
      setDeleting(null);
      setInfo(`Deleted ${f.name}: the address was removed from the core's vault and ${r.purgedSources.toLocaleString()} indexed event entries were removed. To make the old address useless, reset the secret address in Google Calendar.`);
      reload();
    });
  };

  return (
    <section className="lib-pane-section" aria-label="Easy setup: Google Calendar">
      <h3>
        Google Calendar{" "}
        <span className="lib-badge" data-state={feeds && feeds.length > 0 ? "ok" : "off"}>
          {badge}
        </span>
      </h3>
      <GuideCard guide={E.ICAL_GUIDE} notes={E.ICAL_NOTES} />
      {unavailable && <StatusBanner severity="info" message={A.icalErrorText("core_update")} />}
      {loadErr && !unavailable && <StatusBanner severity="error" message={A.icalErrorLine(loadErr)} onDismiss={() => setLoadErr(null)} />}
      {feeds && feeds.length > 0 && (
        <ul className="lib-items" aria-label="Calendars">
          {feeds.map((f) => (
            <FeedRow
              key={f.sourceId}
              feed={f}
              busy={task.busy}
              syncing={syncingId === f.sourceId && task.busy}
              result={results[f.sourceId] ?? null}
              onSync={() => sync(f)}
              onStop={task.stop}
              onSaveOptions={(o) => saveOptions(f, o)}
              onDelete={() => setDeleting(f)}
            />
          ))}
        </ul>
      )}
      {!unavailable && <AddFeedForm count={feeds?.length ?? 0} busy={task.busy} onAdd={add} />}
      {info && <StatusBanner severity="info" message={info} onDismiss={() => setInfo(null)} />}
      {task.error && !deleting && <StatusBanner severity="error" message={A.icalErrorLine(task.error)} onDismiss={task.clear} />}
      {deleting && <DeleteFeedDialog feed={deleting} busy={task.busy} error={task.error} onConfirm={confirmDelete} onClose={() => { setDeleting(null); task.clear(); }} />}
    </section>
  );
}
