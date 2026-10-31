// Settings -> Extensions trust: the folder trust list and the install allowlist. Ports the
// Mac models and their review fixes: a stale-load guard (a list load that started before an
// apply must not overwrite it), "Reload first" (an edit replaces the whole saved list, so a
// failed load can never let an edit overwrite what is saved), and pasted-URL normalisation.
import { call, type CoreClient } from "./core-api.ts";
import {
  decodeAllowlist,
  decodeWorkspaceTrustList,
  decodeWorkspaceTrustSet,
  type Allowlist,
  type WorkspaceTrustItem,
} from "./decoders.ts";
import { describeError, messageForCode } from "./errors.ts";
import { Store } from "./store.ts";

// ---- Allowlist rules (pure) --------------------------------------------------------------

/** `owner/repo` or `owner/*`, lowercased as GitHub names them; null when it is neither.
 *  A pasted GitHub URL names the same entry, as the server reads it. */
export function normalizeSource(raw: string): string | null {
  let s = raw.trim().toLowerCase();
  for (const prefix of ["https://", "http://"]) {
    if (s.startsWith(prefix)) {
      s = s.slice(prefix.length);
      break;
    }
  }
  if (s.startsWith("github.com/")) s = s.slice("github.com/".length);
  while (s.endsWith("/")) s = s.slice(0, -1);
  if (s.endsWith(".git")) s = s.slice(0, -4);
  while (s.endsWith("/")) s = s.slice(0, -1);
  const parts = s.split("/");
  if (parts.length !== 2) return null;
  const ok = (p: string): boolean => p.length > 0 && /^[a-z0-9._-]+$/.test(p);
  if (!ok(parts[0]!)) return null;
  if (parts[1] !== "*" && !ok(parts[1]!)) return null;
  return s;
}

export const IGNORED_REASON = "Not in effect: the operator's current limit no longer covers it.";
export const RELOAD_FIRST = "Reload first: the saved list has not been loaded, so it cannot be changed safely.";

export function ceilingText(ceiling: string[] | null): string {
  if (ceiling === null) return "The operator set no limit: you can add any owner/repo or owner/*.";
  if (ceiling.length === 0) return "The operator allows no additions, so only the operator's list applies.";
  return `You can add sources covered by: ${ceiling.join(", ")}.`;
}

export const TRUST_CONSENT = (path: string): string =>
  `Trust ${path}?\n\nFrom now on, chats in this folder start the MCP servers its .mcp.json file defines, and each one runs a program on this computer with your permissions. Only trust a folder whose contents you wrote or have read.`;

// ---- Folder trust list ----------------------------------------------------------------------

export interface TrustListState {
  items: WorkspaceTrustItem[];
  /** False when the operator turned the server's trust check off (every folder then behaves as trusted). */
  enforced: boolean;
  loaded: boolean;
  loading: boolean;
  error: string | null;
  busy: ReadonlySet<string>;
  /** The folder the user is about to trust: a consent is showing. */
  pendingTrust: WorkspaceTrustItem | null;
}

export class TrustListModel extends Store<TrustListState> {
  readonly #c: CoreClient;
  #changeGeneration = 0;

  constructor(client: CoreClient) {
    super({ items: [], enforced: true, loaded: false, loading: false, error: null, busy: new Set(), pendingTrust: null });
    this.#c = client;
  }

  async load(): Promise<void> {
    if (this.getState().loading) return;
    this.set({ loading: true });
    const started = this.#changeGeneration;
    try {
      const list = decodeWorkspaceTrustList(await call(this.#c, "GET", "/auth/me/workspace-trust"));
      if (started !== this.#changeGeneration || this.getState().busy.size > 0) return;
      this.set({ items: list.items, enforced: list.enforced, error: null, loaded: true });
    } catch (e) {
      this.set({ error: describeError(e) });
    } finally {
      this.set({ loading: false });
    }
  }

  /** Untrusting needs no confirmation; trusting goes through the consent first. */
  async requestChange(item: WorkspaceTrustItem, trusted: boolean): Promise<void> {
    if (trusted) this.set({ pendingTrust: item });
    else await this.#apply(item.path, false);
  }

  cancelPending(): void {
    this.set({ pendingTrust: null });
  }

  async confirmPendingTrust(): Promise<void> {
    const item = this.getState().pendingTrust;
    if (!item) return;
    this.set({ pendingTrust: null });
    await this.#apply(item.path, true);
  }

  /** Adds a folder chosen with the host's folder dialog (asks for the consent like any other trust). */
  addFolder(path: string): void {
    const trimmed = path.trim();
    if (!trimmed) return;
    this.set({ pendingTrust: { path: trimmed, trusted: false, updatedAt: "" } });
  }

  async #apply(path: string, trusted: boolean): Promise<void> {
    if (this.getState().busy.has(path)) return;
    this.#setBusy(path, true);
    try {
      const item = decodeWorkspaceTrustSet(await call(this.#c, "PUT", "/auth/me/workspace-trust", { path, trusted }));
      const items = this.getState().items.slice();
      const i = items.findIndex((x) => x.path === path);
      if (i >= 0) items[i] = item;
      else items.unshift(item);
      this.set({ items, error: null });
    } catch (e) {
      this.set({ error: describeError(e) });
    } finally {
      this.#setBusy(path, false);
      this.#changeGeneration++;
    }
  }

  #setBusy(path: string, on: boolean): void {
    const busy = new Set(this.getState().busy);
    if (on) busy.add(path);
    else busy.delete(path);
    this.set({ busy });
  }
}

// ---- Install allowlist -------------------------------------------------------------------------

export interface AllowlistState {
  allowlist: Allowlist | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  draft: string;
}

export class AllowlistModel extends Store<AllowlistState> {
  readonly #c: CoreClient;
  #generation = 0;

  constructor(client: CoreClient) {
    super({ allowlist: null, loading: false, saving: false, error: null, draft: "" });
    this.#c = client;
  }

  get isLoaded(): boolean {
    return this.getState().allowlist !== null;
  }
  get canAdd(): boolean {
    const s = this.getState();
    return s.allowlist !== null && !s.saving && normalizeSource(s.draft) !== null;
  }

  setDraft(draft: string): void {
    this.set({ draft });
  }

  async load(): Promise<void> {
    const gen = ++this.#generation;
    this.set({ loading: true });
    try {
      const allowlist = decodeAllowlist(await call(this.#c, "GET", "/auth/me/extensions/allowlist"));
      if (gen !== this.#generation) return; // a save finished meanwhile: do not overwrite it
      this.set({ allowlist, error: null });
    } catch (e) {
      if (gen === this.#generation) this.set({ error: describeError(e) });
    } finally {
      if (gen === this.#generation) this.set({ loading: false });
    }
  }

  async addDraft(): Promise<void> {
    const s = this.getState();
    if (!s.allowlist) {
      this.set({ error: RELOAD_FIRST });
      return;
    }
    const entry = normalizeSource(s.draft);
    if (!entry) {
      this.set({ error: messageForCode("INVALID_SOURCE", 400, { entry: s.draft.trim() }) });
      return;
    }
    if (s.allowlist.user.includes(entry)) {
      this.set({ error: `${entry} is already in your list.` });
      return;
    }
    if (await this.#save([...s.allowlist.user, entry], entry)) this.set({ draft: "" });
  }

  async remove(entry: string): Promise<void> {
    const a = this.getState().allowlist;
    if (!a) {
      this.set({ error: RELOAD_FIRST });
      return;
    }
    await this.#save(a.user.filter((x) => x !== entry), entry);
  }

  async #save(sources: string[], entry: string): Promise<boolean> {
    if (this.getState().saving) return false;
    this.set({ saving: true });
    this.#generation++; // invalidate any load in flight
    try {
      const allowlist = decodeAllowlist(await call(this.#c, "PUT", "/auth/me/extensions/allowlist", { sources }));
      this.set({ allowlist, error: null });
      return true;
    } catch (e) {
      this.set({ error: describeError(e, { entry }) });
      return false;
    } finally {
      this.set({ saving: false });
    }
  }
}
