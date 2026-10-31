// The "Google" connection pane of the Library Connections group: setup guide, connect (bring-your-own OAuth
// client, read-only scopes), accounts with per-product options and sync, disconnect.
//
// Rules the pane keeps (docs/spec/google-connectors.md, plan G6):
//  - The client secret is a write-only password field: sent once in `POST /kb/google/start` and cleared from
//    state in the same tick; it is never rendered back, never put in storage, never logged. No token ever reaches
//    this window: the core keeps them.
//  - The Google sign-in address is opened only after `validateAuthUrl` accepted it, through the host opener (which
//    asks the user once per site). The `state` value is never shown.
//  - Everything that came from Google (addresses, labels, calendar and folder names, file names) is rendered as
//    React text children only: no HTML, no links, no images, no remote content.
//  - Long lists are windowed (the Drive folder picker); big runs are chunked with a Stop button and show counters.
//  - Every failure is shown in our wording (google-core.ts); the server's own text is never shown.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import { Dialog } from "../../write/Dialog";
import { windowRange } from "../../windowing.ts";
import type { PaneEnv } from "../SourcePanes";
import {
  ACCOUNT_ID_RE, googleAccounts, googleCalendars, googleDisconnect, googleDriveFolders, googleErrorText, googleSetOptions, lastErrorText, mapGoogleThrown, PRODUCT_LABEL, PRODUCTS,
  type AccountsResult, type CalendarEntry, type DisconnectResult, type FolderEntry, type GoogleAccount, type GoogleError, type Product, type ScopeInfo,
} from "./google-core.ts";
import { chosenProducts, EMPTY_FORM, runConnect, setupState, validateConnectForm, type ConnectForm, type ConnectOutcome, type ConnectPhase, type ConnectResult } from "./connect-flow.ts";
import { gmailMessage, IDLE_GMAIL, runGmailSync, type GmailProgress } from "./gmail-sync.ts";
import { cooldownUntil, runProductSync, syncMessage, type SyncProgress } from "./product-sync.ts";
import {
  DEFAULT_CALENDAR, DEFAULT_DRIVE, DEFAULT_GMAIL, driveContentNote, optionsPayload, parseLabelList, readCalendarOptions, readDriveOptions, readGmailOptions, validateCalendarOptions, validateGmailOptions,
  type CalendarOptions, type DriveOptions, type GmailOptions,
} from "./options.ts";
import * as G from "./guide.ts";
import { Check, CopyButton, ErrorLine, errorMessage, Field, formatWhen, useTask } from "./shared";
export { formatWhen };
import { EasySetup } from "./EasySetup";
import type { IcalApi } from "./ical-api.ts";
import { ADVANCED_SUMMARY } from "./easy.ts";

// ---- shared bits -----------------------------------------------------------------------------

// ---- setup guide -----------------------------------------------------------------------------

export function SetupGuide({ open }: { open: boolean }): ReactNode {
  return (
    <details className="lib-pane-section" open={open} aria-label="Google setup guide">
      <summary>
        <strong>Setup guide: create your Google Cloud OAuth client</strong>
      </summary>
      <p className="lib-muted">{G.BRING_YOUR_OWN}</p>
      <ol>
        {G.GUIDE_STEPS.map((s) => (
          <li key={s.title}>
            <strong>{s.title}.</strong> {s.body}
          </li>
        ))}
      </ol>
      <h4>Scopes to add (all read-only)</h4>
      <ul aria-label="Scopes">
        {G.SCOPE_GROUPS.map((g) => (
          <li key={g.product}>
            <span>
              {g.product} <span className="lib-muted">({g.tier})</span>
            </span>
            <ul>
              {g.scopes.map((s) => (
                <li key={s}>
                  <code className="lib-code">{s}</code> <CopyButton text={s} label={`scope ${s}`} />
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      <p className="lib-muted">{G.TIER_NOTE}</p>
      <p className="lib-muted">{G.TESTING_EXPIRY_NOTE}</p>
      <h4>What this connection does and does not do</h4>
      <ul>
        {G.SECURITY_POINTS.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
    </details>
  );
}

// ---- connect card ----------------------------------------------------------------------------

export function ConnectPhaseText({ phase }: { phase: ConnectPhase }): ReactNode {
  switch (phase) {
    case "starting":
      return "Asking the core to start the sign-in…";
    case "opening":
      return "Opening Google in your browser…";
    case "waiting":
      return "Finish signing in to Google in your browser. This window waits for up to 5 minutes.";
    case "declined":
      return "You chose not to open the Google page. Nothing was changed.";
    case "cancelled":
      return "Stopped waiting. If you already approved in the browser the account may still appear in the list below.";
    case "timeout":
      return "The sign-in was not finished in time. Start again.";
    default:
      return null;
  }
}

export function ConnectCard({
  form,
  setForm,
  busy,
  phase,
  onConnect,
  onCancel,
  reconnectEmail,
  onClearReconnect,
}: {
  form: ConnectForm;
  setForm: (f: ConnectForm) => void;
  busy: boolean;
  phase: ConnectPhase;
  onConnect: () => void;
  onCancel: () => void;
  reconnectEmail: string | null;
  onClearReconnect: () => void;
}): ReactNode {
  const problems = validateConnectForm(form);
  const valid = Object.keys(problems).length === 0;
  const reuse = form.accountId !== null;
  const set = (patch: Partial<ConnectForm>): void => setForm({ ...form, ...patch });
  const tick = (p: Product, v: boolean): void => set({ products: { ...form.products, [p]: v }, ...(p === "gdrive" && !v ? { driveContent: false } : null) });
  return (
    <section className="lib-pane-section" aria-label="Connect a Google account">
      <h3>{reuse ? "Reconnect or add access" : "Connect a Google account"}</h3>
      {reuse && (
        <p className="lib-muted">
          Reconnecting <strong>{reconnectEmail ?? "this account"}</strong>. Leave the client fields empty to reuse the saved client, or paste a new one.{" "}
          <button type="button" className="lib-link-btn" onClick={onClearReconnect} disabled={busy}>
            Connect a different account instead
          </button>
        </p>
      )}
      <Field label="OAuth client ID" error={form.clientId !== "" || !reuse ? problems.clientId : undefined}>
        <input type="text" autoComplete="off" spellCheck={false} value={form.clientId} disabled={busy} onChange={(e) => set({ clientId: e.target.value })} aria-invalid={!!problems.clientId && form.clientId !== ""} placeholder="123456789-abc.apps.googleusercontent.com" />
      </Field>
      <Field label="OAuth client secret (sent once to the core's vault, never shown again)" error={form.clientSecret !== "" ? problems.clientSecret : undefined}>
        <input type="password" autoComplete="off" spellCheck={false} value={form.clientSecret} disabled={busy} onChange={(e) => set({ clientSecret: e.target.value })} aria-invalid={!!problems.clientSecret && form.clientSecret !== ""} />
      </Field>
      <fieldset className="lib-field">
        <legend>What to connect</legend>
        <Check checked={form.products.gmail} onChange={(v) => tick("gmail", v)} disabled={busy}>
          Gmail (read mail; saved as notes)
        </Check>
        <Check checked={form.products.gcal} onChange={(v) => tick("gcal", v)} disabled={busy}>
          Google Calendar (read events; indexed for search)
        </Check>
        <Check checked={form.products.gdrive} onChange={(v) => tick("gdrive", v)} disabled={busy}>
          Google Drive (names, types and dates; indexed for search)
        </Check>
        <Check checked={form.products.gdrive && form.driveContent} onChange={(v) => set({ driveContent: v })} disabled={busy || !form.products.gdrive}>
          Also index file contents (off by default)
        </Check>
        <p className="lib-muted">{G.DRIVE_CONTENT_EXPLAIN}</p>
        {problems.products && (
          <span className="lib-muted" role="alert">
            {problems.products}
          </span>
        )}
      </fieldset>
      <div className="lib-editor-bar">
        <button type="button" className="lib-btn lib-btn-primary" onClick={onConnect} disabled={!valid || busy}>
          {reuse ? "Reconnect" : "Connect"}
        </button>
        {busy && (
          <button type="button" className="lib-btn" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
      <div role="status" aria-live="polite">
        <ConnectPhaseText phase={phase} />
      </div>
      <p className="lib-muted">Chosen: {chosenProducts(form).map((p) => PRODUCT_LABEL[p]).join(", ") || "nothing yet"}. Google will list the access it asks for; compare it with the scopes in the guide above.</p>
    </section>
  );
}

export function OutcomeView({ outcome }: { outcome: ConnectOutcome }): ReactNode {
  return (
    <section className="lib-pane-section" aria-label="Connection result">
      <h3>Connected</h3>
      <p>
        Account: <strong>{outcome.email || "(address not reported)"}</strong>
      </p>
      <ul aria-label="Products">
        {outcome.products.map((p) => (
          <li key={p.product}>
            {PRODUCT_LABEL[p.product]}: <strong>{p.on ? "ON" : "OFF"}</strong>
            {p.requested && !p.on ? " (not allowed on Google's consent screen)" : ""}
          </li>
        ))}
      </ul>
      {outcome.notes.map((n) => (
        <StatusBanner key={n} severity="warning" message={n} />
      ))}
      <details>
        <summary>Access Google granted ({outcome.grantedScopes.length})</summary>
        <ul>
          {outcome.grantedScopes.map((s) => (
            <li key={s}>
              <code className="lib-code">{s}</code>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}

// ---- option editors --------------------------------------------------------------------------

function NumberField({ label, value, min, max, error, onChange }: { label: string; value: number; min: number; max: number; error?: string; onChange: (n: number) => void }): ReactNode {
  return (
    <Field label={label} error={error}>
      <input type="number" min={min} max={max} value={Number.isFinite(value) ? value : ""} onChange={(e) => onChange(e.target.value === "" ? Number.NaN : Number(e.target.value))} aria-invalid={!!error} />
    </Field>
  );
}

export function GmailOptionsEditor({ initial, busy, onSave }: { initial: GmailOptions; busy: boolean; onSave: (o: GmailOptions) => void }): ReactNode {
  const [o, setO] = useState<GmailOptions>(initial);
  const [text, setText] = useState(initial.labels.join(", "));
  const problems = validateGmailOptions(o);
  return (
    <div className="lib-form" role="group" aria-label="Gmail options">
      <Field label="Labels to read (label ids, comma separated; INBOX is the usual one)" error={problems.labels}>
        <input
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setO({ ...o, labels: parseLabelList(e.target.value) });
          }}
          aria-invalid={!!problems.labels}
        />
      </Field>
      <NumberField label="Days to look back on the first fetch" value={o.windowDays} min={1} max={365} error={problems.windowDays} onChange={(n) => setO({ ...o, windowDays: n })} />
      <Check checked={o.includePromotions} onChange={(v) => setO({ ...o, includePromotions: v })}>
        Include the Promotions tab
      </Check>
      <Check checked={o.includeSocial} onChange={(v) => setO({ ...o, includeSocial: v })}>
        Include the Social tab
      </Check>
      <p className="lib-muted">Spam, Trash and Drafts are never read. Changing the labels makes the next fetch start over for the new selection; notes already saved are not duplicated.</p>
      <button type="button" className="lib-btn" disabled={busy || Object.keys(problems).length > 0} onClick={() => onSave(o)}>
        Save Gmail options
      </button>
    </div>
  );
}

export function CalendarOptionsEditor({ initial, busy, calendars, onLoadCalendars, onSave }: { initial: CalendarOptions; busy: boolean; calendars: readonly CalendarEntry[] | null; onLoadCalendars: () => void; onSave: (o: CalendarOptions) => void }): ReactNode {
  const [o, setO] = useState<CalendarOptions>(initial);
  const problems = validateCalendarOptions(o);
  const toggle = (id: string, on: boolean): void => setO({ ...o, calendarIds: on ? [...new Set([...o.calendarIds, id])] : o.calendarIds.filter((x) => x !== id) });
  return (
    <div className="lib-form" role="group" aria-label="Calendar options">
      <div className="lib-editor-bar">
        <button type="button" className="lib-btn" onClick={onLoadCalendars} disabled={busy}>
          {calendars ? "Reload my calendars" : "Load my calendars"}
        </button>
        <span className="lib-muted">{o.calendarIds.length} chosen (the main calendar is called primary)</span>
      </div>
      {calendars && (
        <ul aria-label="Calendars" style={{ maxHeight: 220, overflow: "auto" }}>
          {calendars.map((c) => (
            <li key={c.id}>
              <Check checked={o.calendarIds.includes(c.id)} onChange={(v) => toggle(c.id, v)}>
                {c.summary || c.id}
                {c.primary ? " (main)" : ""}
              </Check>
            </li>
          ))}
        </ul>
      )}
      {problems.calendarIds && (
        <span className="lib-muted" role="alert">
          {problems.calendarIds}
        </span>
      )}
      <NumberField label="Days back" value={o.daysBack} min={0} max={365} error={problems.daysBack} onChange={(n) => setO({ ...o, daysBack: n })} />
      <NumberField label="Days ahead" value={o.daysAhead} min={0} max={730} error={problems.daysAhead} onChange={(n) => setO({ ...o, daysAhead: n })} />
      <button type="button" className="lib-btn" disabled={busy || Object.keys(problems).length > 0} onClick={() => onSave(o)}>
        Save Calendar options
      </button>
    </div>
  );
}

export const FOLDER_ROW_H = 32;
export const FOLDER_VIEW_H = 256;

/** Lazy, windowed folder list: only the visible rows mount, so a folder with thousands of children stays light. */
export function FolderList({ folders, ticked, onToggle, onOpen }: { folders: readonly FolderEntry[]; ticked: ReadonlySet<string>; onToggle: (f: FolderEntry, on: boolean) => void; onOpen: (f: FolderEntry) => void }): ReactNode {
  const [top, setTop] = useState(0);
  const w = windowRange({ total: folders.length, rowHeight: FOLDER_ROW_H, scrollTop: top, viewportHeight: FOLDER_VIEW_H, overscan: 6 });
  return (
    <div role="group" aria-label="Folders" style={{ height: FOLDER_VIEW_H, overflow: "auto" }} onScroll={(e) => setTop(e.currentTarget.scrollTop)} tabIndex={0}>
      <div style={{ paddingTop: w.padTop, paddingBottom: w.padBottom }}>
        {folders.slice(w.start, w.end).map((f, i) => (
          <div key={f.id} role="group" aria-label={f.name || f.id} aria-posinset={w.start + i + 1} aria-setsize={folders.length} style={{ height: FOLDER_ROW_H, display: "flex", alignItems: "center", gap: 8 }}>
            <Check checked={ticked.has(f.id)} onChange={(v) => onToggle(f, v)}>
              {f.name || f.id}
            </Check>
            <button type="button" className="lib-link-btn" onClick={() => onOpen(f)} aria-label={`Open folder ${f.name || f.id}`}>
              Open
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

export function DriveOptionsEditor({
  initial, busy, contentGranted, load, onSave,
}: {
  initial: DriveOptions;
  busy: boolean;
  contentGranted: boolean;
  load: (parent: string | null, signal: AbortSignal) => Promise<FolderEntry[]>;
  onSave: (o: DriveOptions) => void;
}): ReactNode {
  const [o, setO] = useState<DriveOptions>(initial);
  const [path, setPath] = useState<{ id: string | null; name: string }[]>([{ id: null, name: "My Drive" }]);
  const [folders, setFolders] = useState<FolderEntry[] | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [err, setErr] = useState<GoogleError | null>(null);
  const [loading, setLoading] = useState(false);
  const task = useRef<AbortController | null>(null);
  useEffect(() => () => task.current?.abort(), []);
  const open = (next: { id: string | null; name: string }[]): void => {
    task.current?.abort();
    const ac = new AbortController();
    task.current = ac;
    setLoading(true);
    setErr(null);
    load(next[next.length - 1]!.id, ac.signal).then(
      (list) => {
        if (ac.signal.aborted) return;
        setPath(next);
        setFolders(list);
        setNames((n) => ({ ...n, ...Object.fromEntries(list.map((f) => [f.id, f.name])) }));
        setLoading(false);
      },
      (e) => {
        if (ac.signal.aborted) return;
        setErr(mapGoogleThrown(e, ac.signal));
        setLoading(false);
      },
    );
  };
  const ticked = useMemo(() => new Set(o.folderIds), [o.folderIds]);
  const problems = optionsPayload("gdrive", o);
  const note = driveContentNote(o.folderIds.length, contentGranted);
  return (
    <div className="lib-form" role="group" aria-label="Drive options">
      <p className="lib-muted">
        Tick the folders whose file contents may be read{contentGranted ? "" : " (needs the contents access, see the note below)"}. Every other file is indexed by name, type and date only.
      </p>
      <div className="lib-editor-bar">
        <button type="button" className="lib-btn" onClick={() => open(path.length ? path : [{ id: null, name: "My Drive" }])} disabled={busy || loading}>
          {folders ? "Reload folders" : "Browse my folders"}
        </button>
        {path.length > 1 && (
          <button type="button" className="lib-btn" onClick={() => open(path.slice(0, -1))} disabled={loading}>
            Up
          </button>
        )}
        <span className="lib-muted" aria-live="polite">
          {folders ? `In ${path.map((p) => p.name || "folder").join(" / ")}: ${folders.length.toLocaleString()} folders` : ""}
        </span>
      </div>
      {err && <StatusBanner severity="error" message={errorMessage(err.code, err.serverCode)} onDismiss={() => setErr(null)} />}
      {folders && (
        <FolderList
          folders={folders}
          ticked={ticked}
          onToggle={(f, on) => setO({ ...o, folderIds: on ? [...new Set([...o.folderIds, f.id])] : o.folderIds.filter((x) => x !== f.id) })}
          onOpen={(f) => open([...path, { id: f.id, name: f.name }])}
        />
      )}
      <p className="lib-muted">
        {o.folderIds.length === 0 ? "No folders ticked." : `Ticked (${o.folderIds.length}): ${o.folderIds.map((id) => names[id] ?? "folder chosen earlier").join(", ")}`}
      </p>
      <Check checked={o.includeSharedDrives} onChange={(v) => setO({ ...o, includeSharedDrives: v })}>
        Include shared drives (off by default)
      </Check>
      {note && <StatusBanner severity="warning" message={note} />}
      <button type="button" className="lib-btn" disabled={busy || !problems.ok} onClick={() => onSave(o)}>
        Save Drive options
      </button>
    </div>
  );
}

// ---- account card ----------------------------------------------------------------------------

function ConnectorHealth({ product, account }: { product: Product; account: GoogleAccount }): ReactNode {
  const info = account.connectors[product];
  const when = formatWhen(info?.lastRunAt ?? null);
  const err = lastErrorText(info?.lastError ?? null);
  const state = info?.status ?? "idle";
  const label = state === "reconnect_needed" ? "Reconnect needed" : state === "error" ? "Last run failed" : state === "syncing" ? "Syncing" : state === "pending" ? "More pending" : when ? "Healthy" : "Never run";
  return (
    <p className="lib-muted">
      <span className="lib-badge" data-state={state === "idle" || state === "pending" || state === "syncing" ? "ok" : "off"}>
        {label}
      </span>{" "}
      {when ? `Last run ${when}.` : "No run yet."}
      {state === "pending" ? " The core has more to read: run it again." : ""}
      {err ? ` ${err}` : ""}
    </p>
  );
}

export interface AccountCardProps {
  env: PaneEnv;
  account: GoogleAccount;
  onChanged: () => void;
  onReconnect: (account: GoogleAccount) => void;
  onDisconnect: (account: GoogleAccount) => void;
}

export function AccountCard({ env, account, onChanged, onReconnect, onDisconnect }: AccountCardProps): ReactNode {
  const now = env.now ?? Date.now;
  const task = useTask();
  const [gmail, setGmail] = useState<GmailProgress>(IDLE_GMAIL);
  const [syncs, setSyncs] = useState<Partial<Record<"gcal" | "gdrive", SyncProgress>>>({});
  const [cool, setCool] = useState(0);
  const [openOpts, setOpenOpts] = useState<Product | null>(null);
  const [calendars, setCalendars] = useState<CalendarEntry[] | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [rootProblem, setRootProblem] = useState(false);
  const [, tick] = useState(0);
  useEffect(() => {
    if (cool <= now()) return undefined;
    const t = setTimeout(() => tick((x) => x + 1), Math.max(250, cool - now() + 50));
    return () => clearTimeout(t);
  }, [cool, now]);
  const cooling = cool > now();
  const needsReconnect = account.status === "reconnect_needed";
  const id = account.accountId;
  const driveContentGranted = account.driveContent;

  const saveOptions = (product: Product, value: GmailOptions | CalendarOptions | DriveOptions): void => {
    const p = optionsPayload(product, value);
    if (!p.ok) return;
    void task.run(async (signal) => {
      const r = await googleSetOptions(env.core, id, product, p.options, signal);
      setSaved(r.ok ? `${PRODUCT_LABEL[product]} options saved.` : "The core did not confirm the options.");
      onChanged();
    });
  };
  const fetchGmail = (): void => {
    void task.run(async (signal) => {
      setRootProblem(false);
      if (env.hasNotesRoot && !(await env.hasNotesRoot())) {
        setRootProblem(true);
        return;
      }
      setGmail({ ...IDLE_GMAIL, phase: "fetching" });
      const done = await runGmailSync(id, { core: env.core, write: env.write, signal, onProgress: setGmail });
      if (done.phase === "error") setCool(cooldownUntil(done.error, now()));
      onChanged();
    });
  };
  const syncProduct = (product: "gcal" | "gdrive"): void => {
    void task.run(async (signal) => {
      const done = await runProductSync(id, product, { core: env.core, signal, onProgress: (p) => setSyncs((s) => ({ ...s, [product]: p })) });
      if (done.phase === "error") setCool(cooldownUntil(done.error, now()));
      onChanged();
    });
  };
  const loadCalendars = (): void => {
    void task.run(async (signal) => {
      setCalendars(await googleCalendars(env.core, id, signal));
    });
  };
  const gm = gmail;
  const gmDone = gm.phase === "done" || gm.phase === "cancelled" || gm.phase === "error";
  return (
    <section className="lib-pane-section" aria-label={`Google account ${account.email}`}>
      <h3>
        {account.email || "(address not reported)"}{" "}
        <span className="lib-badge" data-state={needsReconnect ? "off" : "ok"}>
          {needsReconnect ? "Reconnect needed" : "Connected"}
        </span>
      </h3>
      {needsReconnect && (
        <StatusBanner severity="warning" message={`${googleErrorText("reconnect_needed")}`} />
      )}
      <ul aria-label="Products">
        {PRODUCTS.map((p) => (
          <li key={p}>
            {PRODUCT_LABEL[p]}: <strong>{account.products.includes(p) ? "ON" : "OFF"}</strong>
            {p === "gdrive" && account.products.includes("gdrive") ? (account.driveContent ? " (file contents allowed)" : " (names, types and dates only)") : ""}
            {!account.products.includes(p) ? " (not allowed; reconnect with it ticked)" : ""}
          </li>
        ))}
      </ul>
      <details>
        <summary>Access Google granted ({account.scopes.length})</summary>
        <ul>
          {account.scopes.map((s) => (
            <li key={s}>
              <code className="lib-code">{s}</code>
            </li>
          ))}
        </ul>
      </details>
      <div className="lib-editor-bar">
        <button type="button" className="lib-btn" onClick={() => onReconnect(account)} disabled={task.busy}>
          {needsReconnect ? "Reconnect" : "Reconnect or add access"}
        </button>
        <button type="button" className="lib-btn lib-btn-danger" onClick={() => onDisconnect(account)} disabled={task.busy}>
          Disconnect…
        </button>
      </div>

      {account.products.includes("gmail") && (
        <section aria-label="Gmail" className="lib-pane-section">
          <h4>Gmail</h4>
          <ConnectorHealth product="gmail" account={account} />
          <div className="lib-editor-bar">
            <button type="button" className="lib-btn lib-btn-primary" onClick={fetchGmail} disabled={task.busy || needsReconnect || cooling}>
              Fetch new mail
            </button>
            {task.busy && (
              <button type="button" className="lib-link-btn" onClick={task.stop}>
                Stop
              </button>
            )}
            <button type="button" className="lib-btn" onClick={() => setOpenOpts(openOpts === "gmail" ? null : "gmail")} aria-expanded={openOpts === "gmail"}>
              Options
            </button>
          </div>
          {rootProblem && <StatusBanner severity="warning" message="No notes folder is chosen, so mail cannot be saved. Choose one in Settings (Workspace), then fetch again." />}
          {gm.phase !== "idle" && gm.phase !== "error" && (
            <div role="status" aria-live="polite">
              {gmailMessage(gm)}
            </div>
          )}
          {gm.phase === "error" && gm.error && <StatusBanner severity="error" message={errorMessage(gm.error, gm.serverCode)} />}
          {gmDone && gm.failedCount > 0 && (
            <div role="alert">
              <p>These {gm.failedCount.toLocaleString()} could not be saved, so this batch was not marked as seen and will be offered again:</p>
              <ul aria-label="Failed notes">
                {gm.failed.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </div>
          )}
          {openOpts === "gmail" && <GmailOptionsEditor initial={readGmailOptions(account.connectors.gmail?.options ?? DEFAULT_GMAIL)} busy={task.busy} onSave={(o) => saveOptions("gmail", o)} />}
        </section>
      )}

      {(["gcal", "gdrive"] as const).map((p) =>
        account.products.includes(p) ? (
          <section key={p} aria-label={PRODUCT_LABEL[p]} className="lib-pane-section">
            <h4>{PRODUCT_LABEL[p]}</h4>
            <ConnectorHealth product={p} account={account} />
            <div className="lib-editor-bar">
              <button type="button" className="lib-btn lib-btn-primary" onClick={() => syncProduct(p)} disabled={task.busy || needsReconnect || cooling}>
                Sync now
              </button>
              {task.busy && syncs[p]?.phase === "running" && (
                <button type="button" className="lib-link-btn" onClick={task.stop}>
                  Stop
                </button>
              )}
              <button type="button" className="lib-btn" onClick={() => setOpenOpts(openOpts === p ? null : p)} aria-expanded={openOpts === p}>
                Options
              </button>
            </div>
            {syncs[p] && syncs[p]!.phase !== "idle" && (
              <div role="status" aria-live="polite">
                {syncMessage(syncs[p]!)}
              </div>
            )}
            {syncs[p]?.phase === "error" && syncs[p]!.error && <StatusBanner severity="error" message={errorMessage(syncs[p]!.error!, syncs[p]!.serverCode)} />}
            {p === "gcal" && openOpts === "gcal" && (
              <CalendarOptionsEditor initial={readCalendarOptions(account.connectors.gcal?.options ?? DEFAULT_CALENDAR)} busy={task.busy} calendars={calendars} onLoadCalendars={loadCalendars} onSave={(o) => saveOptions("gcal", o)} />
            )}
            {p === "gdrive" && openOpts === "gdrive" && (
              <DriveOptionsEditor
                initial={readDriveOptions(account.connectors.gdrive?.options ?? DEFAULT_DRIVE)}
                busy={task.busy}
                contentGranted={driveContentGranted}
                load={(parent, signal) => googleDriveFolders(env.core, id, parent, signal)}
                onSave={(o) => saveOptions("gdrive", o)}
              />
            )}
          </section>
        ) : null,
      )}
      {cooling && <StatusBanner severity="info" message={`Google asked us to slow down. Syncing is paused until ${new Date(cool).toLocaleTimeString()}.`} />}
      {saved && <StatusBanner severity="info" message={saved} onDismiss={() => setSaved(null)} />}
      <ErrorLine task={task} />
    </section>
  );
}

// ---- disconnect ------------------------------------------------------------------------------

export function DisconnectDialog({ account, busy, error, onConfirm, onClose, openExternal }: { account: GoogleAccount; busy: boolean; error: GoogleError | null; onConfirm: () => void; onClose: () => void; openExternal: (url: string) => Promise<void> }): ReactNode {
  const [typed, setTyped] = useState("");
  const expected = account.email || account.accountId;
  const ok = typed.trim().toLowerCase() === expected.toLowerCase();
  return (
    <Dialog title={`Disconnect ${expected}?`} onClose={onClose} role="alertdialog" busy={busy}>
      <div className="lib-form">
        <p>{G.DISCONNECT_EXPLAIN}</p>
        <button type="button" className="lib-link-btn" onClick={() => void openExternal(G.PERMISSIONS_URL)}>
          Open myaccount.google.com/permissions
        </button>
        <label className="lib-field">
          <span>Type {expected} to confirm</span>
          <input type="text" autoComplete="off" spellCheck={false} value={typed} onChange={(e) => setTyped(e.target.value)} data-autofocus="true" />
        </label>
        {error && <StatusBanner severity="error" message={errorMessage(error.code, error.serverCode)} />}
        <div className="lib-modal-actions">
          <button type="button" className="lib-btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="lib-btn lib-btn-danger" onClick={onConfirm} disabled={busy || !ok}>
            Disconnect
          </button>
        </div>
      </div>
    </Dialog>
  );
}

export function disconnectMessage(r: DisconnectResult, email: string): string {
  const base = r.revoked
    ? `${email} is disconnected and Google was asked to revoke the sign-in.`
    : `${email} is disconnected here, but Google could not be reached to revoke the sign-in. Remove the app at myaccount.google.com/permissions to finish.`;
  return `${base} ${r.purgedSources.toLocaleString()} Calendar and Drive search entries were removed. Gmail notes already saved are kept.`;
}

// ---- pane ------------------------------------------------------------------------------------

export function GooglePane({ env, gmailCard = null, ical }: { env: PaneEnv; gmailCard?: ReactNode; ical?: IcalApi }): ReactNode {
  const [advOpen, setAdvOpen] = useState(false);
  const [accounts, setAccounts] = useState<AccountsResult | null>(null);
  const [loadError, setLoadError] = useState<GoogleError | null>(null);
  const [n, setN] = useState(0);
  const [form, setFormState] = useState<ConnectForm>(EMPTY_FORM);
  const [phase, setPhase] = useState<ConnectPhase>("idle");
  const [result, setResult] = useState<ConnectResult | null>(null);
  const [scopes, setScopes] = useState<{ list: ScopeInfo[]; legacyRevoked: boolean } | null>(null);
  const [disconnecting, setDisconnecting] = useState<GoogleAccount | null>(null);
  const [discBusy, setDiscBusy] = useState(false);
  const [discError, setDiscError] = useState<GoogleError | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const flow = useRef<AbortController | null>(null);
  useEffect(() => () => flow.current?.abort(), []);
  const refresh = useCallback(() => setN((x) => x + 1), []);

  useEffect(() => {
    const ac = new AbortController();
    googleAccounts(env.core, ac.signal).then(
      (r) => {
        setAccounts(r);
        setLoadError(null);
      },
      (e) => {
        if (!ac.signal.aborted) setLoadError(mapGoogleThrown(e, ac.signal));
      },
    );
    return () => ac.abort();
  }, [env.core, n]);

  const connecting = phase === "starting" || phase === "opening" || phase === "waiting";
  const state = setupState({ accounts: accounts?.accounts ?? [], legacyMailToken: accounts?.legacyMailToken === true, connecting });
  const reconnectAccount = form.accountId ? accounts?.accounts.find((a) => a.accountId === form.accountId) ?? null : null;

  const connect = (): void => {
    if (flow.current) return;
    const ac = new AbortController();
    flow.current = ac;
    setResult(null);
    setScopes(null);
    setInfo(null);
    const snapshot = form;
    // The secret leaves state the moment the request body is built (runConnect copies it before its first await).
    const p = runConnect(snapshot, {
      core: env.core,
      openAuth: env.openAuth ?? (async (url) => (await env.openExternal(url), true)),
      signal: ac.signal,
      onPhase: setPhase,
      onScopes: (list, legacyRevoked) => setScopes({ list, legacyRevoked }),
      now: env.now,
    });
    setFormState((f) => ({ ...f, clientSecret: "" }));
    void p.then((r) => {
      flow.current = null;
      setResult(r);
      if (r.ok) {
        setFormState({ ...EMPTY_FORM });
        refresh();
      }
    });
  };

  const cancel = (): void => flow.current?.abort();

  const confirmDisconnect = (): void => {
    const acct = disconnecting;
    if (!acct || discBusy) return;
    setDiscBusy(true);
    setDiscError(null);
    googleDisconnect(env.core, acct.accountId, new AbortController().signal).then(
      (r) => {
        setDiscBusy(false);
        setDisconnecting(null);
        setInfo(disconnectMessage(r, acct.email || acct.accountId));
        refresh();
      },
      (e) => {
        setDiscBusy(false);
        setDiscError(mapGoogleThrown(e));
      },
    );
  };

  const headline = state === "connected" ? "Connected" : state === "reconnect_needed" ? "Reconnect needed" : state === "connecting" ? "Connecting" : "Not set up";
  return (
    <div className="lib-pane" role="region" aria-label="Google connection">
      <h2>
        Google{" "}
        <span className="lib-badge" data-state={state === "connected" ? "ok" : "off"}>
          {headline}
        </span>
      </h2>
      <p className="lib-muted">{G.GOOGLE_INTRO}</p>
      <p className="lib-muted">{G.NOTE_UPDATE_RULE}</p>
      {state === "legacy_only" && <StatusBanner severity="warning" message="An older Google sign-in for Email (access to your whole mailbox) is still saved in the core. It is revoked automatically the first time you connect below." />}
      {loadError && <StatusBanner severity="error" message={errorMessage(loadError.code, loadError.serverCode)} onDismiss={() => setLoadError(null)} />}
      <EasySetup env={env} gmailCard={gmailCard} ical={ical} />
      <details className="lib-pane-section" aria-label="Advanced Google connection" open={advOpen || (accounts !== null && (accounts.accounts.length > 0 || connecting))} onToggle={(e) => setAdvOpen(e.currentTarget.open)}>
        <summary>
          <strong>{ADVANCED_SUMMARY}</strong>
        </summary>
        <p className="lib-muted">{G.WHERE_NOTES_GO}</p>
      <SetupGuide open={false} />
      <ConnectCard
        form={form}
        setForm={setFormState}
        busy={connecting}
        phase={phase}
        onConnect={connect}
        onCancel={cancel}
        reconnectEmail={reconnectAccount?.email ?? null}
        onClearReconnect={() => setFormState((f) => ({ ...f, accountId: null }))}
      />
      {scopes && scopes.legacyRevoked && <StatusBanner severity="info" message="The older full-mailbox Google sign-in was revoked." />}
      {scopes && connecting && scopes.list.length > 0 && (
        <details open>
          <summary>Access being requested ({scopes.list.length})</summary>
          <ul>
            {scopes.list.map((s) => (
              <li key={s.scope}>
                <code className="lib-code">{s.scope}</code> <span className="lib-muted">({s.tier})</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {result && !result.ok && result.phase === "failed" && result.error && <StatusBanner severity="error" message={errorMessage(result.error, result.serverCode)} />}
      {result && result.ok && <OutcomeView outcome={result.outcome} />}
      {info && <StatusBanner severity="info" message={info} onDismiss={() => setInfo(null)} />}
      {accounts && accounts.accounts.length === 0 && state !== "connecting" && <p className="lib-muted">No Google account is connected.</p>}
      {accounts?.accounts.map((a) => (
        <AccountCard
          key={a.accountId}
          env={env}
          account={a}
          onChanged={refresh}
          onReconnect={(acct) => {
            setFormState({ ...EMPTY_FORM, accountId: acct.accountId, products: { gmail: acct.products.includes("gmail") || acct.products.length === 0, gcal: acct.products.includes("gcal"), gdrive: acct.products.includes("gdrive") }, driveContent: acct.driveContent });
            setResult(null);
          }}
          onDisconnect={(acct) => {
            setDiscError(null);
            setDisconnecting(acct);
          }}
        />
      ))}
      {disconnecting && ACCOUNT_ID_RE.test(disconnecting.accountId) && (
        <DisconnectDialog account={disconnecting} busy={discBusy} error={discError} onConfirm={confirmDisconnect} onClose={() => setDisconnecting(null)} openExternal={env.openExternal} />
      )}
      </details>
    </div>
  );
}
