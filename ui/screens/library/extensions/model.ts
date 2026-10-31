// State machine of the Extensions screen (Installed / Browse / Install). Framework-free: components
// subscribe through `subscribe` / `getSnapshot` (useSyncExternalStore) and call the actions below.
//
// Rules this file keeps (each has a test):
//  - appearing reads only the core's cached lists (`installed`, `active`, cached `catalog`); every request
//    that reaches GitHub or the registry starts from a user action (install, check, preview, apply,
//    repair, refresh);
//  - one modal at a time (`sheet` is a single union); a consent wins over a preview (apply turns the latter
//    into the former);
//  - nothing is switched on or updated without the consent sheet when the item declares executable kinds:
//    Apply stays disabled until every kind is ticked, and exactly the ticked kinds are sent, bound to the
//    commit the sheet named (the pinned one for enable, the previewed one for update);
//  - an update is always applied by commit (the previewed one): UPDATE_CHANGED goes back to a fresh preview,
//    ALREADY_CURRENT reloads the list, an item that moved under the sheet is re-reviewed, never applied;
//  - one request per item at a time (a second tap says "Busy" instead of doing nothing);
//  - search results of a superseded request are dropped (sequence guard);
//  - the tab changes only when the action behind it succeeded.
import type { ExtensionsApi } from "./api.ts";
import type { ActiveSummary, CatalogEntry, CatalogPage, CatalogSource, InstalledItem, ItemResult, UpdatePreview } from "./decoders.ts";
import { ExtApiError, errorText, isRetryable } from "./errors.ts";
import { consentLines, catalogNeverFetched, hasUpdate, orderKinds, outcomeText, refreshSummary, repairText, validateInstallPath, validateInstallUrl, type ConsentLine } from "./presentation.ts";

export type Tab = "installed" | "browse" | "install";

export type Retry =
  | { kind: "preview"; itemId: string }
  | { kind: "update"; itemId: string; commit: string; consents: string[] | null }
  | { kind: "install"; url: string; path: string | null }
  | { kind: "check"; id: string | null }
  | { kind: "refresh" };

export interface Notice {
  text: string;
  error: boolean;
  retry: Retry | null;
}

export interface ConsentRequest {
  itemId: string;
  itemName: string;
  /** The commit whose code the consent covers. */
  commit: string;
  /** For an update: the commit it moves from (the item must still be there when the user confirms). */
  from: string | null;
  purpose: "enable" | "update";
  lines: ConsentLine[];
  kinds: string[];
}

export type ConfirmAction =
  | { kind: "rollback"; itemId: string; itemName: string; toCommit: string }
  | { kind: "uninstall"; itemId: string; itemName: string; commit: string }
  | { kind: "repair"; itemId: string; itemName: string; commit: string }
  | { kind: "install"; entry: CatalogEntry };

export type Sheet =
  | { kind: "consent"; request: ConsentRequest; ticked: string[] }
  | { kind: "preview"; item: InstalledItem; preview: UpdatePreview }
  | { kind: "confirm"; action: ConfirmAction };

export interface BrowseState {
  query: string;
  kind: string | null;
  results: CatalogEntry[];
  total: number;
  sources: CatalogSource[];
  loaded: boolean;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  refreshing: boolean;
}

export interface InstallState {
  url: string;
  path: string;
  installing: boolean;
  /** Set after a failed Install click; cleared on edit. */
  fieldError: string | null;
  last: ItemResult | null;
}

export interface ExtensionsState {
  tab: Tab;
  items: readonly InstalledItem[];
  corrupt: boolean;
  loaded: boolean;
  loading: boolean;
  loadError: string | null;
  selectedId: string | null;
  busy: readonly string[];
  checking: boolean;
  catalogOff: boolean;
  notice: Notice | null;
  sheet: Sheet | null;
  active: ActiveSummary | null;
  browse: BrowseState;
  install: InstallState;
}

const MAX_BROWSE_RESULTS = 5000;

const INITIAL: ExtensionsState = {
  tab: "installed",
  items: [],
  corrupt: false,
  loaded: false,
  loading: false,
  loadError: null,
  selectedId: null,
  busy: [],
  checking: false,
  catalogOff: false,
  notice: null,
  sheet: null,
  active: null,
  browse: { query: "", kind: null, results: [], total: 0, sources: [], loaded: false, loading: false, loadingMore: false, error: null, refreshing: false },
  install: { url: "", path: "", installing: false, fieldError: null, last: null },
};

export class ExtensionsModel {
  private state: ExtensionsState = INITIAL;
  private listeners = new Set<() => void>();
  private life = new AbortController();
  private installedSeq = 0;
  private searchSeq = 0;
  private busySet = new Set<string>();

  private readonly api: ExtensionsApi;
  constructor(api: ExtensionsApi) {
    this.api = api;
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = (): ExtensionsState => this.state;

  /** Cancels everything in flight; later answers are ignored. */
  dispose(): void {
    this.life.abort();
    this.listeners.clear();
  }

  private set(patch: Partial<ExtensionsState>): void {
    if (this.life.signal.aborted) return;
    this.state = { ...this.state, ...patch };
    for (const l of [...this.listeners]) l();
  }
  private setBrowse(patch: Partial<BrowseState>): void {
    this.set({ browse: { ...this.state.browse, ...patch } });
  }
  private setInstall(patch: Partial<InstallState>): void {
    this.set({ install: { ...this.state.install, ...patch } });
  }
  private get signal(): AbortSignal {
    return this.life.signal;
  }

  // ---- notices -------------------------------------------------------------------------------
  dismissNotice(): void {
    this.set({ notice: null });
  }
  private succeed(text: string): void {
    this.set({ notice: { text, error: false, retry: null } });
  }
  private info(text: string, error = true): void {
    this.set({ notice: { text, error, retry: null } });
  }
  private fail(e: unknown, retry: Retry | null = null): void {
    if (e instanceof ExtApiError && e.code === "ABORTED") return;
    const text = errorText(e);
    const code = e instanceof ExtApiError ? e.code : null;
    if (code === "CATALOG_DISABLED") this.set({ catalogOff: true });
    this.set({ notice: { text, error: true, retry: e instanceof ExtApiError && isRetryable(e) ? retry : null } });
  }

  /** Runs the retry the last failure offered (only offered for failures that changed nothing). */
  async retry(): Promise<void> {
    const r = this.state.notice?.retry;
    if (!r) return;
    this.set({ notice: null });
    switch (r.kind) {
      case "preview": {
        const item = this.item(r.itemId);
        if (item) await this.openPreview(item);
        return;
      }
      case "update": {
        const item = this.item(r.itemId);
        if (item) await this.applyUpdate(item, r.commit, r.consents);
        return;
      }
      case "install":
        await this.runInstall(r.url, r.path);
        return;
      case "check":
        await this.checkUpdates(r.id);
        return;
      case "refresh":
        await this.refreshCatalog();
        return;
    }
  }

  // ---- tabs, selection ----------------------------------------------------------------------
  /** Switching to Browse reads the cached catalog (no network) the first time. */
  async showTab(tab: Tab): Promise<void> {
    this.set({ tab });
    if (tab === "browse" && !this.state.browse.loaded && !this.state.browse.loading) await this.search();
  }
  select(id: string | null): void {
    this.set({ selectedId: id });
  }

  // ---- installed ----------------------------------------------------------------------------
  /** Reads the core's installed record and active summary: cached/local reads only. */
  async init(): Promise<void> {
    await Promise.all([this.loadInstalled(), this.loadActive()]);
  }

  async loadInstalled(): Promise<void> {
    const mine = ++this.installedSeq;
    this.set({ loading: true });
    try {
      const list = await this.api.installed(this.signal);
      if (mine !== this.installedSeq) return;
      const sel = this.state.selectedId;
      this.set({ items: list.items, corrupt: list.corrupt, loaded: true, loading: false, loadError: null, selectedId: sel && list.items.some((i) => i.id === sel) ? sel : null });
    } catch (e) {
      if (mine !== this.installedSeq) return;
      if (e instanceof ExtApiError && e.code === "ABORTED") return;
      this.set({ loading: false, loadError: errorText(e) });
    }
  }

  async loadActive(): Promise<void> {
    try {
      this.set({ active: await this.api.active(this.signal) });
    } catch {
      // the summary is a convenience; the Installed list is the source of truth
    }
  }

  item(id: string): InstalledItem | undefined {
    return this.state.items.find((i) => i.id === id);
  }
  get updateCount(): number {
    return this.state.items.filter(hasUpdate).length;
  }

  private replace(item: InstalledItem): void {
    const items = this.state.items.slice();
    const i = items.findIndex((x) => x.id === item.id);
    if (i >= 0) items[i] = item;
    else items.push(item);
    this.set({ items });
  }

  /** One request per item at a time; a rejected call says so instead of doing nothing. */
  private async withBusy(id: string, work: () => Promise<void>): Promise<boolean> {
    if (this.busySet.has(id)) {
      this.info("Busy, try again.");
      return false;
    }
    this.busySet.add(id);
    this.set({ busy: [...this.busySet] });
    try {
      await work();
    } finally {
      this.busySet.delete(id);
      this.set({ busy: [...this.busySet] });
    }
    return true;
  }

  // ---- enable / consent ---------------------------------------------------------------------
  /** The switch was turned on: ask for consent when the item can run code, otherwise switch it on. */
  async requestEnable(item: InstalledItem): Promise<void> {
    if (this.state.sheet) return;
    const kinds = orderKinds(item.executableKinds);
    if (kinds.length === 0) {
      await this.toggle(item, true, null);
      return;
    }
    this.set({
      sheet: {
        kind: "consent",
        ticked: [],
        request: { itemId: item.id, itemName: item.name, commit: item.pinnedCommit, from: null, purpose: "enable", lines: consentLines(kinds, item.members, item.permissions), kinds },
      },
    });
  }

  async disable(item: InstalledItem): Promise<void> {
    await this.toggle(item, false, null);
  }

  private async toggle(item: InstalledItem, enabled: boolean, consents: string[] | null): Promise<void> {
    await this.withBusy(item.id, async () => {
      try {
        const r = await this.api.toggle({ id: item.id, enabled, consents: consents ?? undefined }, this.signal);
        this.replace(r.item);
        this.succeed(enabled ? `${item.name} is on.` : `${item.name} is off.`);
      } catch (e) {
        if (enabled && e instanceof ExtApiError && e.code === "CONSENT_REQUIRED") {
          // The item's declared kinds changed since the list was read: reload and ask again with the real list.
          this.fail(e);
          await this.loadInstalled();
          const fresh = this.item(item.id);
          if (fresh && fresh.executableKinds.length > 0 && !this.state.sheet) {
            this.set({
              sheet: {
                kind: "consent",
                ticked: [],
                request: { itemId: fresh.id, itemName: fresh.name, commit: fresh.pinnedCommit, from: null, purpose: "enable", lines: consentLines(fresh.executableKinds, fresh.members, fresh.permissions), kinds: orderKinds(fresh.executableKinds) },
              },
            });
          }
          return;
        }
        this.fail(e);
      }
    });
  }

  tick(kind: string, on: boolean): void {
    const sh = this.state.sheet;
    if (!sh || sh.kind !== "consent" || !sh.request.kinds.includes(kind)) return;
    const set = new Set(sh.ticked);
    if (on) set.add(kind);
    else set.delete(kind);
    this.set({ sheet: { ...sh, ticked: orderKinds([...set]) } });
  }

  /** True when every kind the sheet names is ticked. */
  get canConfirmConsent(): boolean {
    const sh = this.state.sheet;
    return !!sh && sh.kind === "consent" && sh.request.kinds.length > 0 && sh.request.kinds.every((k) => sh.ticked.includes(k));
  }

  /** Apply in the consent sheet. Refused (no-op) while a kind is unticked; a second tap finds no sheet. */
  async confirmConsent(): Promise<void> {
    const sh = this.state.sheet;
    if (!sh || sh.kind !== "consent" || !this.canConfirmConsent) return;
    const { request } = sh;
    const consents = orderKinds(sh.ticked);
    this.set({ sheet: null });
    const item = this.item(request.itemId);
    if (!item) {
      this.info(`${request.itemName} is no longer installed, so nothing was changed.`);
      return;
    }
    if (request.purpose === "enable") {
      // The consent named the code at this commit; a different one needs its own consent.
      if (item.pinnedCommit !== request.commit) {
        this.info(`${item.name} changed while you were deciding. Switch it on again to review it.`);
        return;
      }
      await this.toggle(item, true, consents);
      return;
    }
    if (item.pinnedCommit !== request.from) {
      await this.rereview(item, "That item changed while you were deciding; review the update again.");
      return;
    }
    await this.applyUpdate(item, request.commit, consents);
  }

  async setMember(item: InstalledItem, memberId: string, checked: boolean): Promise<void> {
    await this.withBusy(item.id, async () => {
      try {
        const r = await this.api.toggleMember({ id: item.id, memberId, enabled: checked }, this.signal);
        this.replace(r.item);
      } catch (e) {
        this.fail(e);
      }
    });
  }

  // ---- install ------------------------------------------------------------------------------
  setInstallUrl(url: string): void {
    this.setInstall({ url: url.slice(0, 400), fieldError: null });
  }
  setInstallPath(path: string): void {
    this.setInstall({ path: path.slice(0, 400), fieldError: null });
  }

  /** Install from the typed GitHub address. The core pins the commit and installs it switched off; nothing runs. */
  async install(): Promise<boolean> {
    const { url, path } = this.state.install;
    const bad = validateInstallUrl(url) ?? validateInstallPath(path);
    if (bad) {
      this.setInstall({ fieldError: bad });
      return false;
    }
    const p = path.trim();
    return this.runInstall(url.trim(), p === "" ? null : p);
  }

  /** Browse -> Install asks first (it names the repository), then installs. */
  requestBrowseInstall(entry: CatalogEntry): void {
    if (this.state.sheet || !entry.installable || entry.installed || !entry.sourceUrl) return;
    this.set({ sheet: { kind: "confirm", action: { kind: "install", entry } } });
  }

  private async runInstall(url: string, path: string | null): Promise<boolean> {
    if (this.state.install.installing) return false;
    this.setInstall({ installing: true });
    try {
      const r = await this.api.install({ url, path }, this.signal);
      this.setInstall({ installing: false, last: r });
      this.replace(r.item);
      this.succeed(r.alreadyInstalled ? `${r.item.name} was already installed at this commit.` : `Installed ${r.item.name}. It is off until you switch it on.`);
      if (this.state.browse.loaded) void this.search();
      return true;
    } catch (e) {
      this.setInstall({ installing: false, last: null });
      this.fail(e, { kind: "install", url, path });
      return false;
    }
  }
  dismissLastInstall(): void {
    this.setInstall({ last: null });
  }

  // ---- destructive actions (always confirmed, naming the item and the commit) ---------------
  requestRollback(item: InstalledItem): void {
    if (this.state.sheet || !item.previous) return;
    this.set({ sheet: { kind: "confirm", action: { kind: "rollback", itemId: item.id, itemName: item.name, toCommit: item.previous.pinnedCommit } } });
  }
  requestUninstall(item: InstalledItem): void {
    if (this.state.sheet) return;
    this.set({ sheet: { kind: "confirm", action: { kind: "uninstall", itemId: item.id, itemName: item.name, commit: item.pinnedCommit } } });
  }
  requestRepair(item: InstalledItem): void {
    if (this.state.sheet) return;
    this.set({ sheet: { kind: "confirm", action: { kind: "repair", itemId: item.id, itemName: item.name, commit: item.pinnedCommit } } });
  }

  /** The confirm button. The sheet closes first, so a second tap does nothing. */
  async confirmAction(): Promise<void> {
    const sh = this.state.sheet;
    if (!sh || sh.kind !== "confirm") return;
    const a = sh.action;
    this.set({ sheet: null });
    if (a.kind === "install") {
      const url = a.entry.sourceUrl;
      if (!url) return;
      const ok = await this.runInstall(url, a.entry.sourcePath ?? null);
      if (ok) this.set({ tab: "install" });
      return;
    }
    const item = this.item(a.itemId);
    if (!item) {
      this.info(`${a.itemName} is no longer installed, so nothing was changed.`);
      return;
    }
    const commit = a.kind === "rollback" ? item.pinnedCommit : a.commit;
    if (a.kind !== "rollback" && item.pinnedCommit !== commit) {
      this.info(`${item.name} changed while you were deciding. Nothing was changed.`);
      return;
    }
    if (a.kind === "rollback" && item.previous?.pinnedCommit !== a.toCommit) {
      this.info(`${item.name} changed while you were deciding. Nothing was changed.`);
      return;
    }
    if (a.kind === "uninstall") await this.uninstall(item);
    else if (a.kind === "rollback") await this.rollback(item);
    else await this.repair(item);
  }

  private async uninstall(item: InstalledItem): Promise<void> {
    await this.withBusy(item.id, async () => {
      try {
        await this.api.uninstall(item.id, this.signal);
      } catch (e) {
        this.fail(e);
        return;
      }
      const last = this.state.install.last;
      this.set({ items: this.state.items.filter((i) => i.id !== item.id), selectedId: this.state.selectedId === item.id ? null : this.state.selectedId });
      if (last?.item.id === item.id) this.setInstall({ last: null });
      this.succeed(`Removed ${item.name} and its stored files.`);
      // The Browse "installed" badge came from the core before the removal.
      if (this.state.browse.loaded) await this.search();
    });
  }

  private async rollback(item: InstalledItem): Promise<void> {
    await this.withBusy(item.id, async () => {
      try {
        const r = await this.api.rollback(item.id, this.signal);
        this.replace(r.item);
        this.succeed(outcomeText(r.summary, "Rolled back"));
      } catch (e) {
        this.fail(e);
      }
    });
  }

  private async repair(item: InstalledItem): Promise<void> {
    await this.withBusy(item.id, async () => {
      try {
        const r = await this.api.repair(item.id, this.signal);
        this.replace(r.item);
        this.succeed(repairText(r));
      } catch (e) {
        this.fail(e);
      }
    });
  }

  // ---- updates ------------------------------------------------------------------------------
  /** Asks GitHub for the newest commit of each installed item (or one). User-initiated: one GitHub call per item. */
  async checkUpdates(id: string | null = null): Promise<void> {
    if (this.state.checking) return;
    this.set({ checking: true });
    try {
      const r = await this.api.checkUpdates(id, this.signal);
      this.set({ checking: false });
      await this.loadInstalled();
      const n = r.results.filter((x) => x.updateAvailable).length;
      const errors = r.results.filter((x) => x.error).length;
      let text = n === 0 ? "Everything checked is up to date." : `${n} update${n === 1 ? "" : "s"} available.`;
      if (errors > 0) text += ` ${errors} could not be checked.`;
      this.succeed(text);
    } catch (e) {
      this.set({ checking: false });
      this.fail(e, { kind: "check", id });
    }
  }

  /** Downloads the candidate in memory and shows what would change. Writes nothing. */
  async openPreview(item: InstalledItem, reviewNotice?: string): Promise<void> {
    if (this.state.sheet) return;
    await this.withBusy(item.id, async () => {
      try {
        const p = await this.api.previewUpdate({ id: item.id, commit: item.update?.latest ?? null }, this.signal);
        if (this.state.sheet) return;
        this.set({ sheet: { kind: "preview", item, preview: p } });
        if (reviewNotice) this.succeed(reviewNotice);
      } catch (e) {
        if (e instanceof ExtApiError && e.code === "ALREADY_CURRENT") await this.loadInstalled();
        this.fail(e, { kind: "preview", itemId: item.id });
      }
    });
  }

  /** Apply in the preview sheet. A candidate that needs consent goes through the consent sheet first. */
  async applyPreview(): Promise<void> {
    const sh = this.state.sheet;
    if (!sh || sh.kind !== "preview") return;
    const { item, preview: p } = sh;
    this.set({ sheet: null });
    const current = this.item(item.id);
    if (!current) {
      this.info(`${item.name} is no longer installed, so nothing was changed.`);
      return;
    }
    if (current.pinnedCommit !== p.from) {
      await this.rereview(current, "That item changed while you were reviewing; review the update again.");
      return;
    }
    if (p.consent.required && p.consent.kinds.length > 0) {
      const kinds = orderKinds(p.consent.kinds);
      this.set({
        sheet: {
          kind: "consent",
          ticked: [],
          request: {
            itemId: item.id,
            itemName: item.name,
            commit: p.to,
            from: p.from,
            purpose: "update",
            kinds,
            lines: consentLines(kinds, p.newMembers.map((m) => ({ type: m.type, name: m.name })), item.permissions),
          },
        },
      });
      return;
    }
    await this.applyUpdate(item, p.to, null);
  }

  private async rereview(item: InstalledItem, notice: string): Promise<void> {
    await this.loadInstalled();
    await this.openPreview(this.item(item.id) ?? item, notice);
  }

  /** Always sends the commit the user previewed (and consented to). UPDATE_CHANGED re-previews; ALREADY_CURRENT reloads. */
  private async applyUpdate(item: InstalledItem, commit: string, consents: string[] | null): Promise<void> {
    let follow: "repreview" | "reload" | null = null;
    await this.withBusy(item.id, async () => {
      try {
        const r = await this.api.applyUpdate({ id: item.id, commit, consents }, this.signal);
        this.replace(r.item);
        this.succeed(outcomeText(r.summary, "Updated"));
      } catch (e) {
        const code = e instanceof ExtApiError ? e.code : null;
        if (code === "UPDATE_CHANGED") follow = "repreview";
        else if (code === "ALREADY_CURRENT") follow = "reload";
        else this.fail(e, { kind: "update", itemId: item.id, commit, consents });
      }
    });
    if (follow === "repreview") await this.rereview(item, "That update changed; review it again.");
    else if (follow === "reload") {
      await this.loadInstalled();
      this.succeed("Already up to date.");
    }
  }

  // ---- sheets -------------------------------------------------------------------------------
  dismissSheet(): void {
    this.set({ sheet: null });
  }

  // ---- browse -------------------------------------------------------------------------------
  setQuery(query: string): void {
    this.setBrowse({ query: query.slice(0, 200) });
  }
  setKind(kind: string | null): void {
    this.setBrowse({ kind });
  }

  /** Reads the cached catalog (no network). A newer search supersedes an older one. */
  async search(): Promise<void> {
    const mine = ++this.searchSeq;
    const { query, kind } = this.state.browse;
    this.setBrowse({ loading: true, loadingMore: false });
    try {
      const page = await this.api.catalog({ query: query.trim(), kind, limit: 50, offset: 0 }, this.signal);
      if (mine !== this.searchSeq) return;
      this.setBrowse({ results: page.results, total: page.total, sources: page.sources, loaded: true, loading: false, error: null });
    } catch (e) {
      if (mine !== this.searchSeq) return;
      if (e instanceof ExtApiError && e.code === "ABORTED") return;
      this.setBrowse({ loading: false, error: errorText(e) });
      if (e instanceof ExtApiError && e.code === "CATALOG_DISABLED") this.set({ catalogOff: true });
    }
  }

  /** The next page of the same search (cached). Dropped if another search started meanwhile. */
  async loadMore(): Promise<void> {
    const b = this.state.browse;
    if (b.loading || b.loadingMore || b.results.length >= b.total || b.results.length >= MAX_BROWSE_RESULTS) return;
    const mine = this.searchSeq;
    const offset = b.results.length;
    this.setBrowse({ loadingMore: true });
    try {
      const page: CatalogPage = await this.api.catalog({ query: b.query.trim(), kind: b.kind, limit: 50, offset }, this.signal);
      if (mine !== this.searchSeq) return;
      const seen = new Set(this.state.browse.results.map((r) => `${r.indexId}|${r.sourcePath ?? ""}|${r.name}`));
      const fresh = page.results.filter((r) => !seen.has(`${r.indexId}|${r.sourcePath ?? ""}|${r.name}`));
      this.setBrowse({ results: this.state.browse.results.concat(fresh), total: page.total, sources: page.sources, loadingMore: false });
    } catch (e) {
      if (mine !== this.searchSeq) return;
      this.setBrowse({ loadingMore: false, error: errorText(e) });
    }
  }

  /** Fetches the indexes from GitHub and the MCP registry. The only Browse action that reaches the network. */
  async refreshCatalog(): Promise<void> {
    if (this.state.browse.refreshing) return;
    this.setBrowse({ refreshing: true });
    try {
      const r = await this.api.refreshCatalog(this.signal);
      this.setBrowse({ refreshing: false });
      await this.search();
      this.succeed(refreshSummary(r));
    } catch (e) {
      this.setBrowse({ refreshing: false });
      this.fail(e, { kind: "refresh" });
    }
  }

  get neverFetched(): boolean {
    return catalogNeverFetched(this.state.browse.sources);
  }
}
