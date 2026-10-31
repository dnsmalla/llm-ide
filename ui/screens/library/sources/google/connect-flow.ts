// The connect flow: validate the form, ask the core to start (`POST /kb/google/start`), check the returned
// address, open it in the system browser, then poll `GET /kb/google/status` until the core reports the outcome,
// the deadline passes or the user cancels. Pure apart from the injected core, opener and clock.
//
// Secrets: `clientSecret` is read once, sent in `start`, and the caller clears its field right after `runConnect`
// is called (the request body is built synchronously before the first await, so clearing is safe at once).
// The `state` value is held in a local variable only: never returned, never put in a message or log.

import type { SourcesCore } from "../source-core.ts";
import { ACCOUNT_ID_RE, connectFailureCode, GoogleError, googleStart, googleStatus, mapGoogleThrown, PRODUCTS, type GoogleErrorCode, type Product, type ScopeInfo } from "./google-core.ts";
import { validateAuthUrl } from "./auth-url.ts";

// ---- form ------------------------------------------------------------------------------------

export interface ConnectForm {
  clientId: string;
  clientSecret: string;
  products: Record<Product, boolean>;
  /** Only meaningful with Drive ticked. */
  driveContent: boolean;
  /** Set for a reconnect or an upgrade of an existing account. */
  accountId: string | null;
}

export const EMPTY_FORM: ConnectForm = { clientId: "", clientSecret: "", products: { gmail: true, gcal: false, gdrive: false }, driveContent: false, accountId: null };

export type FormProblems = Partial<Record<"clientId" | "clientSecret" | "products" | "accountId", string>>;

export const CLIENT_ID_RE = /^[A-Za-z0-9._-]{10,200}$/;
const MAX_SECRET = 300;

export function chosenProducts(f: ConnectForm): Product[] {
  return PRODUCTS.filter((p) => f.products[p]);
}

/** Problems that stop the Connect button. The secret is only checked for shape (never echoed in a message). */
export function validateConnectForm(f: ConnectForm): FormProblems {
  const p: FormProblems = {};
  if (chosenProducts(f).length === 0) p.products = "Tick at least one of Gmail, Calendar or Drive.";
  if (f.accountId !== null && !ACCOUNT_ID_RE.test(f.accountId)) p.accountId = "That account is not valid. Reload the list.";
  const idBlank = f.clientId.trim() === "";
  const secBlank = f.clientSecret === "";
  const reuse = f.accountId !== null && idBlank && secBlank; // reconnect with the stored client
  if (!reuse) {
    if (idBlank || !CLIENT_ID_RE.test(f.clientId.trim())) p.clientId = "Paste the OAuth client ID from Google Cloud (it ends in .apps.googleusercontent.com).";
    // eslint-disable-next-line no-control-regex
    if (secBlank || f.clientSecret.length > MAX_SECRET || f.clientSecret !== f.clientSecret.trim() || /[\u0000-\u001f\u007f]/.test(f.clientSecret)) p.clientSecret = "Paste the client secret exactly as shown: no spaces or line breaks, up to 300 characters.";
  }
  return p;
}

// ---- setup state machine ---------------------------------------------------------------------

export type SetupState = "no_account" | "connecting" | "connected" | "reconnect_needed" | "legacy_only";

export interface SetupInput {
  accounts: readonly { status: "connected" | "reconnect_needed" }[];
  legacyMailToken: boolean;
  connecting: boolean;
}

/** What the pane headline and the guide's default open state follow from. */
export function setupState(i: SetupInput): SetupState {
  if (i.connecting) return "connecting";
  if (i.accounts.some((a) => a.status === "reconnect_needed")) return "reconnect_needed";
  if (i.accounts.length > 0) return "connected";
  return i.legacyMailToken ? "legacy_only" : "no_account";
}

export type ConnectPhase = "idle" | "starting" | "opening" | "waiting" | "complete" | "failed" | "cancelled" | "timeout" | "declined";

export type ConnectEvent =
  | { type: "start" }
  | { type: "started" }
  | { type: "opened" }
  | { type: "declined" }
  | { type: "complete" }
  | { type: "failed" }
  | { type: "timeout" }
  | { type: "cancel" }
  | { type: "reset" };

const BUSY: readonly ConnectPhase[] = ["starting", "opening", "waiting"];

/** Legal transitions only; an event that does not apply in the current phase changes nothing. */
export function reduceConnect(phase: ConnectPhase, e: ConnectEvent): ConnectPhase {
  switch (e.type) {
    case "start":
      return BUSY.includes(phase) ? phase : "starting";
    case "started":
      return phase === "starting" ? "opening" : phase;
    case "opened":
      return phase === "opening" ? "waiting" : phase;
    case "declined":
      return phase === "opening" ? "declined" : phase;
    case "complete":
      return phase === "waiting" ? "complete" : phase;
    case "failed":
      return BUSY.includes(phase) ? "failed" : phase;
    case "timeout":
      return phase === "waiting" ? "timeout" : phase;
    case "cancel":
      return BUSY.includes(phase) ? "cancelled" : phase;
    case "reset":
      return BUSY.includes(phase) ? phase : "idle";
  }
}

// ---- outcome ---------------------------------------------------------------------------------

export interface ProductOutcome {
  product: Product;
  requested: boolean;
  on: boolean;
}

export interface ConnectOutcome {
  accountId: string;
  email: string;
  products: ProductOutcome[];
  grantedScopes: string[];
  /** Plain-language notes, e.g. a box unticked on Google's consent screen. */
  notes: string[];
  driveContent: boolean;
}

const LABELS: Record<Product, string> = { gmail: "Gmail", gcal: "Google Calendar", gdrive: "Google Drive" };

export function describeOutcome(
  requested: readonly Product[],
  driveContentRequested: boolean,
  r: { accountId: string; email: string; products: readonly Product[]; grantedScopes: readonly string[]; missingScopes: readonly string[]; driveContent: boolean },
): ConnectOutcome {
  const products: ProductOutcome[] = PRODUCTS.map((p) => ({ product: p, requested: requested.includes(p), on: r.products.includes(p) }));
  const notes: string[] = [];
  const off = products.filter((p) => p.requested && !p.on).map((p) => LABELS[p.product]);
  if (off.length > 0) notes.push(`Scope mismatch: ${off.join(", ")} ${off.length === 1 ? "was" : "were"} not allowed on Google's consent screen, so ${off.length === 1 ? "it is" : "they are"} OFF. Connect again and keep every box ticked to turn ${off.length === 1 ? "it" : "them"} on.`);
  else if (r.missingScopes.length > 0) notes.push("Google left out some of the requested access, but every product you asked for is on.");
  if (requested.includes("gdrive") && driveContentRequested && r.products.includes("gdrive") && !r.driveContent) notes.push("File contents for Drive were not allowed, so Drive is indexed by names, types and dates only.");
  const keptOn = products.filter((p) => !p.requested && p.on).map((p) => LABELS[p.product]);
  if (keptOn.length > 0) notes.push(`${keptOn.join(", ")} stays on from an earlier connection of this account.`);
  return { accountId: r.accountId, email: r.email, products, grantedScopes: [...r.grantedScopes], notes, driveContent: r.driveContent };
}

// ---- run -------------------------------------------------------------------------------------

export interface ConnectDeps {
  core: SourcesCore;
  /** Opens an address in the system browser through the host; resolves false when the user declined its prompt. */
  openAuth: (url: string) => Promise<boolean>;
  signal: AbortSignal;
  onPhase?: (p: ConnectPhase) => void;
  /** Shown to the user for the Connect dialog's scope list. */
  onScopes?: (s: ScopeInfo[], legacyRevoked: boolean) => void;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
}

export const POLL_FIRST_MS = 1500;
export const POLL_MAX_MS = 5000;
export const POLL_GROWTH = 1.3;
/** Consecutive transport failures tolerated while polling (the browser step may sleep the machine). */
export const POLL_MAX_FAILURES = 4;
export const POLL_GRACE_MS = 5000;
export const FLOW_MAX_MS = 300_000;

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

export type ConnectResult =
  | { ok: true; outcome: ConnectOutcome }
  | { ok: false; phase: "failed" | "cancelled" | "timeout" | "declined"; error: GoogleErrorCode | null; serverCode: string | null };

/**
 * Runs one connection. Never throws: every failure is a `{ ok: false }` with a code the UI words itself.
 * The form must already have passed `validateConnectForm`; it is validated again here (defence in depth).
 */
export async function runConnect(form: ConnectForm, deps: ConnectDeps): Promise<ConnectResult> {
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  let phase: ConnectPhase = "idle";
  const go = (e: ConnectEvent): void => {
    phase = reduceConnect(phase, e);
    deps.onPhase?.(phase);
  };
  const fail = (e: unknown): ConnectResult => {
    const err = mapGoogleThrown(e, deps.signal);
    if (err.code === "cancelled") {
      go({ type: "cancel" });
      return { ok: false, phase: "cancelled", error: null, serverCode: null };
    }
    go({ type: "failed" });
    return { ok: false, phase: "failed", error: err.code, serverCode: err.serverCode };
  };
  go({ type: "start" });
  if (Object.keys(validateConnectForm(form)).length > 0) return fail(new GoogleError("validation"));
  const requested = chosenProducts(form);
  const driveContent = form.products.gdrive && form.driveContent;
  let state = "";
  let expiresMs = FLOW_MAX_MS + POLL_GRACE_MS;
  try {
    const useOwn = form.clientId.trim() !== "" && form.clientSecret !== "";
    // The body is built (and the secret copied into it) before any await: the caller may clear its field now.
    const start = await googleStart(
      deps.core,
      { ...(useOwn ? { clientId: form.clientId.trim(), clientSecret: form.clientSecret } : null), products: requested, driveContent, ...(form.accountId ? { accountId: form.accountId } : null) },
      deps.signal,
    );
    state = start.state;
    expiresMs = Math.min(FLOW_MAX_MS, start.expiresInSec > 0 ? start.expiresInSec * 1000 : FLOW_MAX_MS) + POLL_GRACE_MS;
    deps.onScopes?.(start.scopes, start.legacyMailTokenRevoked);
    go({ type: "started" });
    const safe = validateAuthUrl(start.authUrl, { state, redirectPort: start.redirectPort });
    if (!safe) throw new GoogleError("unsafe_auth_url");
    const opened = await deps.openAuth(safe);
    if (deps.signal.aborted) throw new GoogleError("cancelled");
    if (!opened) {
      go({ type: "declined" });
      return { ok: false, phase: "declined", error: null, serverCode: null };
    }
    go({ type: "opened" });
  } catch (e) {
    return fail(e);
  }
  const began = now();
  let delay = POLL_FIRST_MS;
  let failures = 0;
  try {
    for (;;) {
      if (deps.signal.aborted) throw new GoogleError("cancelled");
      let st = null;
      try {
        st = await googleStatus(deps.core, state, deps.signal);
        failures = 0;
      } catch (e) {
        const err = mapGoogleThrown(e, deps.signal);
        // A refused or unauthorised poll is final; a transport blip is retried a few times.
        if (err.code !== "unavailable" && err.code !== "timeout" && err.code !== "upstream") throw err;
        failures += 1;
        if (failures >= POLL_MAX_FAILURES) throw err;
      }
      if (st) {
        if (st.status === "complete") {
          go({ type: "complete" });
          return { ok: true, outcome: describeOutcome(requested, driveContent, st) };
        }
        if (st.status === "error") throw new GoogleError(connectFailureCode(st.message));
        // `unknown`: the core has no such flow (expired, replaced, or already read). Terminal; do not poll a dead state.
        if (st.status === "unknown") throw new GoogleError("timeout");
      }
      if (now() - began >= expiresMs) {
        go({ type: "timeout" });
        return { ok: false, phase: "timeout", error: "timeout", serverCode: null };
      }
      await sleep(delay, deps.signal);
      delay = Math.min(POLL_MAX_MS, Math.round(delay * POLL_GROWTH));
    }
  } catch (e) {
    return fail(e);
  }
}
