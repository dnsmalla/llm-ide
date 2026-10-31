// Typed access to the core's Google connector routes (`/kb/google/*`, docs/spec/google-connectors.md section 6,
// contract schema/http/google.schema.json) and the mapping of every failure to a code the UI words itself.
//
// Rules this module keeps:
//  - The OAuth client secret travels in exactly one place: the body of `POST /kb/google/start`. It is never an
//    argument anywhere else, never returned by any route, never logged, never stored in state after the call.
//  - No token ever reaches this code: the core keeps the refresh token in its vault and the access token in
//    memory. Responses carry account ids, addresses, scope names, counts and note text only.
//  - The server's error MESSAGE is never shown (it can name a Google reason); only our wording plus the stable
//    server error CODE (a short constant, for support).
//  - Everything that originated at Google (an address, a label, a calendar or folder name, a note body) is only
//    ever carried as a string and rendered as text by the components.
//
// Pure apart from the injected `SourcesCore` (the shell's core client wrapped in adapter.ts, which holds the token).

import type { SourcesCore } from "../source-core.ts";

export type Product = "gmail" | "gcal" | "gdrive";
export const PRODUCTS: readonly Product[] = ["gmail", "gcal", "gdrive"];
export const PRODUCT_LABEL: Record<Product, string> = { gmail: "Gmail", gcal: "Google Calendar", gdrive: "Google Drive" };

export const isProduct = (v: unknown): v is Product => v === "gmail" || v === "gcal" || v === "gdrive";
export const ACCOUNT_ID_RE = /^[a-f0-9]{12}$/;

// ---- errors ----------------------------------------------------------------------------------

export type GoogleErrorCode =
  | "validation"
  | "not_found"
  | "forbidden"
  | "not_granted"
  | "batch_unknown"
  | "reconnect_needed"
  | "sync_running"
  | "busy"
  | "rate_limited"
  | "google_auth"
  | "google_permission"
  | "google_gone"
  | "upstream"
  | "refused"
  | "bad_response"
  | "scope_mismatch"
  | "extra_scope_refused"
  | "no_refresh_token"
  | "bad_identity"
  | "unsafe_auth_url"
  | "core_update"
  | "bad_url"
  | "unauthorized"
  | "timeout"
  | "unavailable"
  | "feature_disabled"
  | "cancelled"
  | "failed";

export class GoogleError extends Error {
  readonly code: GoogleErrorCode;
  /** The server's error code constant (never its message), for support. */
  readonly serverCode: string | null;
  constructor(code: GoogleErrorCode, serverCode: string | null = null) {
    super(code);
    this.name = "GoogleError";
    this.code = code;
    this.serverCode = serverCode;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function envelopeCode(body: unknown): string | null {
  if (!isRecord(body)) return null;
  if (isRecord(body.error)) return typeof body.error.code === "string" ? body.error.code.slice(0, 64) : null;
  return typeof body.error === "string" ? body.error.slice(0, 64) : null;
}

/** Every server error code of the Google routes and of the library under them, mapped to a UI code. */
const SERVER_CODES: Readonly<Record<string, GoogleErrorCode>> = {
  VALIDATION_FAILED: "validation",
  GOOGLE_BAD_REQUEST: "validation",
  GOOGLE_NOT_FOUND: "not_found",
  FORBIDDEN: "forbidden",
  GOOGLE_PRODUCT_NOT_GRANTED: "not_granted",
  GOOGLE_BATCH_UNKNOWN: "batch_unknown",
  GOOGLE_RECONNECT_NEEDED: "reconnect_needed",
  GOOGLE_INVALID_GRANT: "reconnect_needed",
  GOOGLE_INVALID_CLIENT: "reconnect_needed",
  GOOGLE_SYNC_RUNNING: "sync_running",
  GOOGLE_BUSY: "busy",
  GOOGLE_RATE_LIMITED: "rate_limited",
  GOOGLE_UNAUTHORIZED: "google_auth",
  GOOGLE_FORBIDDEN: "google_permission",
  GOOGLE_GONE: "google_gone",
  GOOGLE_HTTP_ERROR: "upstream",
  GOOGLE_TOKEN_ERROR: "upstream",
  GOOGLE_FETCH_REFUSED: "refused",
  GOOGLE_BAD_JSON: "bad_response",
  GOOGLE_SCOPE_MISMATCH: "scope_mismatch",
  GOOGLE_NO_REFRESH_TOKEN: "no_refresh_token",
  GOOGLE_BAD_ID_TOKEN: "bad_identity",
  feature_disabled: "feature_disabled",
};

/** Maps an HTTP failure (status + body) to a `GoogleError`. */
export function mapGoogleFailure(status: number, body: unknown): GoogleError {
  const sc = envelopeCode(body);
  if (sc && Object.prototype.hasOwnProperty.call(SERVER_CODES, sc)) return new GoogleError(SERVER_CODES[sc]!, sc);
  if (status === 401) return new GoogleError("unauthorized", sc);
  if (status === 403) return new GoogleError("forbidden", sc);
  if (status === 404) return new GoogleError("not_found", sc);
  if (status === 409) return new GoogleError("failed", sc);
  if (status === 429) return new GoogleError("rate_limited", sc);
  if (status === 408 || status === 504) return new GoogleError("timeout", sc);
  if (status === 400 || status === 422) return new GoogleError("validation", sc);
  if (status === 502 || status === 503) return new GoogleError("upstream", sc);
  return new GoogleError("failed", sc);
}

/** Maps a thrown transport error (or an abort) to a `GoogleError`. */
export function mapGoogleThrown(e: unknown, signal?: AbortSignal): GoogleError {
  if (e instanceof GoogleError) return e;
  if (signal?.aborted) return new GoogleError("cancelled");
  const code = (e as { code?: unknown } | null)?.code;
  if (code === "ABORTED") return new GoogleError("cancelled");
  if (code === "TIMEOUT") return new GoogleError("timeout");
  if (code === "NO_SESSION" || code === "SESSION_EXPIRED") return new GoogleError("unauthorized");
  return new GoogleError("unavailable");
}

/** Plain-language wording for each code. Never includes anything the server or Google said. */
export function googleErrorText(code: GoogleErrorCode): string {
  switch (code) {
    case "validation":
      return "The core rejected these settings. Check the fields and try again.";
    case "not_found":
      return "That Google account is not connected any more. Reload the list; connect it again if it is gone.";
    case "forbidden":
      return "This sign-in belongs to a different session. Start the connection again from this window.";
    case "not_granted":
      return "That part of Google was not allowed for this account (it was unticked on Google's consent screen). Reconnect the account with it ticked.";
    case "batch_unknown":
      return "The core no longer knows this batch (it was already confirmed or replaced). Fetch again; notes already saved are not duplicated.";
    case "reconnect_needed":
      return "Google no longer accepts this account's saved sign-in (the grant was revoked, expired, or the OAuth client changed). Reconnect the account. In Google's Testing mode a sign-in expires after about 7 days (unverified).";
    case "sync_running":
      return "A sync for this account is already running. Wait for it to finish, then try again.";
    case "busy":
      return "Too many Google sign-ins are in progress. Wait a minute and start again.";
    case "rate_limited":
      return "Google asked us to slow down and the core already retried with delays. Wait a few minutes, then try again. Nothing was lost.";
    case "google_auth":
      return "Google refused the saved sign-in. Reconnect the account.";
    case "google_permission":
      return "Google refused this request. Check that the Gmail, Calendar and Drive APIs are enabled in your Google Cloud project and that the account is a test user.";
    case "google_gone":
      return "Google says the saved position is too old. The core starts that part over on the next run; run it again.";
    case "upstream":
      return "Google could not be reached or refused the request. Nothing was imported from this attempt.";
    case "refused":
      return "The core refused to contact an unexpected address. Nothing was imported.";
    case "bad_response":
      return "Google sent an answer the core could not read. Nothing was imported from this attempt; try again later.";
    case "scope_mismatch":
      return "Google did not grant the access that was asked for (a box was unticked on its consent screen). Connect again and keep every box ticked.";
    case "extra_scope_refused":
      return "Google granted more access than was requested, so the connection was refused and the grant revoked. Connect again.";
    case "no_refresh_token":
      return "Google did not return a long-lived sign-in. Remove the app at myaccount.google.com/permissions, then connect again.";
    case "bad_identity":
      return "Google's identity answer did not check out (wrong client, expired, or mismatched). Nothing was saved; connect again.";
    case "unsafe_auth_url":
      return "The core returned a sign-in address that is not a Google sign-in page. It was not opened.";
    case "core_update":
      return "Available after the core update: this version of the core does not have this connector yet. Nothing was changed.";
    case "bad_url":
      return "The core did not accept that address. Copy the secret address in iCal format again from Google Calendar.";
    case "unauthorized":
      return "Sign in to the core again, then retry.";
    case "timeout":
      return "This took too long. The core may still be working; check again in a moment. Nothing was lost.";
    case "unavailable":
      return "The core is not reachable. Nothing was changed.";
    case "feature_disabled":
      return "This feature is switched off in this build of the core.";
    case "cancelled":
      return "Stopped. Anything already saved is kept; nothing is half-written.";
    default:
      return "That did not work. Nothing was changed.";
  }
}

/** Wording for a `lastError` the core stored on a connector (a stable code or short fixed text, never a body). */
export function lastErrorText(raw: string | null): string | null {
  if (raw === null || raw === "") return null;
  if (raw === "Reconnect needed") return googleErrorText("reconnect_needed");
  if (Object.prototype.hasOwnProperty.call(SERVER_CODES, raw)) return googleErrorText(SERVER_CODES[raw]!);
  return "The last run did not finish. Run it again.";
}

/** Wording for the message of a failed connection (`GET /kb/google/status` with `status: error`). Our words only. */
export function connectFailureCode(message: string): GoogleErrorCode {
  const m = message.toLowerCase();
  if (m.includes("granted more access")) return "extra_scope_refused";
  if (m.includes("granted no access") || m.includes("none of the requested access")) return "scope_mismatch";
  if (m.includes("refresh token")) return "no_refresh_token";
  if (m.includes("identity")) return "bad_identity";
  if (m.includes("timed out")) return "timeout";
  return "failed";
}

// ---- transport -------------------------------------------------------------------------------

const SHORT = 60_000;
const LONG = 180_000;

/** Calls the core and returns the body of a 2xx answer; any other outcome throws a `GoogleError`. */
export async function callGoogle<T = unknown>(core: SourcesCore, method: "GET" | "POST", path: string, body: unknown, signal: AbortSignal, timeoutMs: number = SHORT): Promise<T> {
  let res: { status: number; body: unknown };
  try {
    res = await core.call(method, path, body, signal, timeoutMs);
  } catch (e) {
    throw mapGoogleThrown(e, signal);
  }
  if (signal.aborted) throw new GoogleError("cancelled");
  if (res.status < 200 || res.status >= 300) throw mapGoogleFailure(res.status, res.body);
  return res.body as T;
}

// ---- decoders --------------------------------------------------------------------------------

const clip = (v: unknown, n: number): string => (typeof v === "string" ? v.slice(0, n) : "");
const int = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
const strList = (v: unknown, max: number, len: number): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, max).map((x) => x.slice(0, len)) : []);
function mustRecord(v: unknown): Record<string, unknown> {
  if (!isRecord(v)) throw new GoogleError("bad_response");
  return v;
}

export interface ScopeInfo {
  scope: string;
  tier: "basic" | "restricted" | "sensitive" | "unknown";
}

export interface StartResult {
  authUrl: string;
  state: string;
  redirectPort: number;
  expiresInSec: number;
  scopes: ScopeInfo[];
  legacyMailTokenRevoked: boolean;
}

export function decodeStart(b: unknown): StartResult {
  const r = mustRecord(b);
  if (typeof r.authUrl !== "string" || typeof r.state !== "string" || r.state === "") throw new GoogleError("bad_response");
  const scopes: ScopeInfo[] = [];
  for (const s of Array.isArray(r.scopes) ? r.scopes.slice(0, 20) : []) {
    if (!isRecord(s) || typeof s.scope !== "string") continue;
    const tier = s.tier === "basic" || s.tier === "restricted" || s.tier === "sensitive" ? s.tier : "unknown";
    scopes.push({ scope: s.scope.slice(0, 200), tier });
  }
  return { authUrl: r.authUrl, state: r.state, redirectPort: int(r.redirectPort), expiresInSec: int(r.expiresInSec), scopes, legacyMailTokenRevoked: r.legacyMailTokenRevoked === true };
}

export type ConnectStatus =
  | { status: "pending" }
  | { status: "unknown" }
  | { status: "error"; message: string }
  | { status: "complete"; accountId: string; email: string; products: Product[]; grantedScopes: string[]; missingScopes: string[]; driveContent: boolean };

export function decodeStatus(b: unknown): ConnectStatus {
  const r = mustRecord(b);
  if (r.status === "pending") return { status: "pending" };
  if (r.status === "error") return { status: "error", message: clip(r.message, 300) };
  if (r.status === "complete") {
    if (typeof r.accountId !== "string" || !ACCOUNT_ID_RE.test(r.accountId)) throw new GoogleError("bad_response");
    return {
      status: "complete",
      accountId: r.accountId,
      email: clip(r.email, 320),
      products: (Array.isArray(r.products) ? r.products : []).filter(isProduct),
      grantedScopes: strList(r.grantedScopes, 30, 200),
      missingScopes: strList(r.missingScopes, 30, 200),
      driveContent: r.driveContent === true,
    };
  }
  return { status: "unknown" };
}

export type ConnectorState = "idle" | "pending" | "syncing" | "error" | "reconnect_needed";
const CONNECTOR_STATES: readonly ConnectorState[] = ["idle", "pending", "syncing", "error", "reconnect_needed"];

export interface ConnectorInfo {
  status: ConnectorState;
  lastRunAt: string | null;
  lastError: string | null;
  options: Record<string, unknown>;
}

export interface GoogleAccount {
  accountId: string;
  email: string;
  status: "connected" | "reconnect_needed";
  products: Product[];
  driveContent: boolean;
  scopes: string[];
  connectors: Partial<Record<Product, ConnectorInfo>>;
}

export interface AccountsResult {
  accounts: GoogleAccount[];
  legacyMailToken: boolean;
}

function decodeConnector(v: unknown): ConnectorInfo {
  const r = isRecord(v) ? v : {};
  const status = CONNECTOR_STATES.includes(r.status as ConnectorState) ? (r.status as ConnectorState) : "idle";
  return { status, lastRunAt: typeof r.lastRunAt === "string" ? r.lastRunAt.slice(0, 40) : null, lastError: typeof r.lastError === "string" ? r.lastError.slice(0, 300) : null, options: isRecord(r.options) ? r.options : {} };
}

export function decodeAccounts(b: unknown): AccountsResult {
  const r = mustRecord(b);
  const accounts: GoogleAccount[] = [];
  for (const a of Array.isArray(r.accounts) ? r.accounts.slice(0, 50) : []) {
    if (!isRecord(a) || typeof a.accountId !== "string" || !ACCOUNT_ID_RE.test(a.accountId)) continue;
    const connectors: Partial<Record<Product, ConnectorInfo>> = {};
    if (isRecord(a.connectors)) for (const p of PRODUCTS) if (a.connectors[p] !== undefined) connectors[p] = decodeConnector(a.connectors[p]);
    accounts.push({
      accountId: a.accountId,
      email: clip(a.email, 320),
      status: a.status === "reconnect_needed" ? "reconnect_needed" : "connected",
      products: (Array.isArray(a.products) ? a.products : []).filter(isProduct),
      driveContent: a.driveContent === true,
      scopes: strList(a.scopes, 30, 200),
      connectors,
    });
  }
  return { accounts, legacyMailToken: r.legacyMailToken === true };
}

export interface DisconnectResult {
  ok: boolean;
  revoked: boolean;
  purgedSources: number;
}

export function decodeDisconnect(b: unknown): DisconnectResult {
  const r = mustRecord(b);
  return { ok: r.ok === true, revoked: r.revoked === true, purgedSources: int(r.purgedSources) };
}

export interface OptionsResult {
  ok: boolean;
  options: Record<string, unknown>;
  contentGranted: boolean | null;
}

export function decodeOptionsResult(b: unknown): OptionsResult {
  const r = mustRecord(b);
  return { ok: r.ok === true, options: isRecord(r.options) ? r.options : {}, contentGranted: typeof r.contentGranted === "boolean" ? r.contentGranted : null };
}

export interface CalendarEntry {
  id: string;
  summary: string;
  primary: boolean;
  accessRole: string;
}

export function decodeCalendars(b: unknown): CalendarEntry[] {
  const r = mustRecord(b);
  const out: CalendarEntry[] = [];
  for (const c of Array.isArray(r.calendars) ? r.calendars.slice(0, 250) : []) {
    if (!isRecord(c) || typeof c.id !== "string" || c.id === "") continue;
    out.push({ id: c.id.slice(0, 300), summary: clip(c.summary, 200), primary: c.primary === true, accessRole: clip(c.accessRole, 30) });
  }
  return out;
}

export interface FolderEntry {
  id: string;
  name: string;
}

export function decodeFolders(b: unknown): FolderEntry[] {
  const r = mustRecord(b);
  const out: FolderEntry[] = [];
  for (const f of Array.isArray(r.folders) ? r.folders.slice(0, 1000) : []) {
    if (!isRecord(f) || typeof f.id !== "string" || f.id === "") continue;
    out.push({ id: f.id.slice(0, 120), name: clip(f.name, 200) });
  }
  return out;
}

export interface GmailNoteIn {
  threadId: string;
  noteFile: string;
  title: string;
  markdown: string;
  messageCount: number;
  lastAt: string | null;
}

export interface Tombstone {
  threadId: string;
  noteFile: string;
  line: string;
}

export interface GmailStats {
  threads: number;
  messages: number;
  skipped: number;
  oversize: number;
  rebootstrapped: boolean;
  truncated: boolean;
}

export interface GmailFetch {
  accountId: string;
  batchId: string;
  mode: "bootstrap" | "history";
  pending: boolean;
  stats: GmailStats;
  tombstones: Tombstone[];
  notes: GmailNoteIn[];
}

/** Hard ceilings so a hostile or buggy core cannot make one answer unbounded in memory. */
export const MAX_NOTES_PER_FETCH = 200;
export const MAX_TOMBSTONES_PER_FETCH = 500;

export function decodeGmailFetch(b: unknown): GmailFetch {
  const r = mustRecord(b);
  if (typeof r.batchId !== "string" || r.batchId === "" || r.batchId.length > 100) throw new GoogleError("bad_response");
  const st = isRecord(r.stats) ? r.stats : {};
  const notes: GmailNoteIn[] = [];
  for (const n of Array.isArray(r.notes) ? r.notes.slice(0, MAX_NOTES_PER_FETCH) : []) {
    if (!isRecord(n) || typeof n.noteFile !== "string" || typeof n.markdown !== "string") continue;
    notes.push({ threadId: clip(n.threadId, 200), noteFile: n.noteFile.slice(0, 300), title: clip(n.title, 300), markdown: n.markdown, messageCount: int(n.messageCount), lastAt: typeof n.lastAt === "string" ? n.lastAt.slice(0, 40) : null });
  }
  const tombstones: Tombstone[] = [];
  for (const t of Array.isArray(r.tombstones) ? r.tombstones.slice(0, MAX_TOMBSTONES_PER_FETCH) : []) {
    if (!isRecord(t) || typeof t.noteFile !== "string" || typeof t.line !== "string") continue;
    tombstones.push({ threadId: clip(t.threadId, 200), noteFile: t.noteFile.slice(0, 300), line: t.line.slice(0, 200) });
  }
  return {
    accountId: clip(r.accountId, 20),
    batchId: r.batchId,
    mode: r.mode === "history" ? "history" : "bootstrap",
    pending: r.pending === true,
    stats: { threads: int(st.threads), messages: int(st.messages), skipped: int(st.skipped), oversize: int(st.oversize), rebootstrapped: st.rebootstrapped === true, truncated: st.truncated === true },
    tombstones,
    notes,
  };
}

export function decodeSeen(b: unknown): { ok: boolean; pending: boolean } {
  const r = mustRecord(b);
  return { ok: r.ok === true, pending: r.pending === true };
}

export interface CalendarRun {
  calendarId: string;
  mode: "full" | "incremental";
  events: number;
  cancelled: number;
  resynced: boolean;
  pending: boolean;
}

export interface DriveStats {
  files: number;
  removed: number;
  withContent: number;
  metadataOnly: number;
  skippedShared: number;
  contentSkipped: number;
  restarted: boolean;
  truncated: boolean;
}

export type SyncResult =
  | { product: "gcal"; pending: boolean; events: number; cancelled: number; calendars: CalendarRun[] }
  | { product: "gdrive"; pending: boolean; mode: "bootstrap" | "changes"; stats: DriveStats };

export function decodeSync(b: unknown): SyncResult {
  const r = mustRecord(b);
  if (r.product === "gcal") {
    const calendars: CalendarRun[] = [];
    for (const c of Array.isArray(r.calendars) ? r.calendars.slice(0, 50) : []) {
      if (!isRecord(c)) continue;
      calendars.push({ calendarId: clip(c.calendarId, 300), mode: c.mode === "incremental" ? "incremental" : "full", events: int(c.events), cancelled: int(c.cancelled), resynced: c.resynced === true, pending: c.pending === true });
    }
    return { product: "gcal", pending: r.pending === true, events: int(r.events), cancelled: int(r.cancelled), calendars };
  }
  if (r.product === "gdrive") {
    const s = isRecord(r.stats) ? r.stats : {};
    return {
      product: "gdrive",
      pending: r.pending === true,
      mode: r.mode === "changes" ? "changes" : "bootstrap",
      stats: { files: int(s.files), removed: int(s.removed), withContent: int(s.withContent), metadataOnly: int(s.metadataOnly), skippedShared: int(s.skippedShared), contentSkipped: int(s.contentSkipped), restarted: s.restarted === true, truncated: s.truncated === true },
    };
  }
  throw new GoogleError("bad_response");
}

// ---- routes ----------------------------------------------------------------------------------

export interface StartRequest {
  /** Both omitted for a reconnect or an upgrade: the core reuses the account's stored client. */
  clientId?: string;
  clientSecret?: string;
  products: Product[];
  driveContent: boolean;
  accountId?: string;
}

/** The only function that sends the client secret. The caller clears its own copy right after the call. */
export async function googleStart(core: SourcesCore, req: StartRequest, signal: AbortSignal): Promise<StartResult> {
  const body: Record<string, unknown> = { products: req.products, driveContent: req.driveContent };
  if (req.clientId !== undefined && req.clientSecret !== undefined) {
    body.clientId = req.clientId;
    body.clientSecret = req.clientSecret;
  }
  if (req.accountId !== undefined) body.accountId = req.accountId;
  return decodeStart(await callGoogle<unknown>(core, "POST", "/kb/google/start", body, signal, SHORT));
}

export async function googleStatus(core: SourcesCore, state: string, signal: AbortSignal): Promise<ConnectStatus> {
  return decodeStatus(await callGoogle<unknown>(core, "GET", `/kb/google/status?state=${encodeURIComponent(state)}`, undefined, signal, SHORT));
}

export async function googleAccounts(core: SourcesCore, signal: AbortSignal): Promise<AccountsResult> {
  return decodeAccounts(await callGoogle<unknown>(core, "GET", "/kb/google/accounts", undefined, signal, SHORT));
}

function checkedAccount(accountId: string): string {
  if (!ACCOUNT_ID_RE.test(accountId)) throw new GoogleError("validation");
  return accountId;
}

export async function googleDisconnect(core: SourcesCore, accountId: string, signal: AbortSignal): Promise<DisconnectResult> {
  return decodeDisconnect(await callGoogle<unknown>(core, "POST", "/kb/google/disconnect", { accountId: checkedAccount(accountId) }, signal, SHORT));
}

export async function googleSetOptions(core: SourcesCore, accountId: string, product: Product, options: Record<string, unknown>, signal: AbortSignal): Promise<OptionsResult> {
  return decodeOptionsResult(await callGoogle<unknown>(core, "POST", "/kb/google/options", { accountId: checkedAccount(accountId), product, options }, signal, SHORT));
}

export async function googleCalendars(core: SourcesCore, accountId: string, signal: AbortSignal): Promise<CalendarEntry[]> {
  return decodeCalendars(await callGoogle<unknown>(core, "GET", `/kb/google/calendars?accountId=${encodeURIComponent(checkedAccount(accountId))}`, undefined, signal, SHORT));
}

/** `parent` is `root` (omitted) or a folder id the core returned earlier. */
export async function googleDriveFolders(core: SourcesCore, accountId: string, parent: string | null, signal: AbortSignal): Promise<FolderEntry[]> {
  const q = parent && /^[A-Za-z0-9_-]{5,100}$/.test(parent) ? `&parent=${encodeURIComponent(parent)}` : "";
  return decodeFolders(await callGoogle<unknown>(core, "GET", `/kb/google/drive/folders?accountId=${encodeURIComponent(checkedAccount(accountId))}${q}`, undefined, signal, SHORT));
}

export async function googleGmailFetch(core: SourcesCore, accountId: string, signal: AbortSignal): Promise<GmailFetch> {
  return decodeGmailFetch(await callGoogle<unknown>(core, "POST", "/kb/google/gmail/fetch", { accountId: checkedAccount(accountId) }, signal, LONG));
}

export async function googleGmailSeen(core: SourcesCore, accountId: string, batchId: string, signal: AbortSignal): Promise<{ ok: boolean; pending: boolean }> {
  return decodeSeen(await callGoogle<unknown>(core, "POST", "/kb/google/gmail/seen", { accountId: checkedAccount(accountId), batchId }, signal, SHORT));
}

export async function googleSync(core: SourcesCore, accountId: string, product: "gcal" | "gdrive", signal: AbortSignal): Promise<SyncResult> {
  return decodeSync(await callGoogle<unknown>(core, "POST", "/kb/google/sync", { accountId: checkedAccount(accountId), product }, signal, LONG));
}
