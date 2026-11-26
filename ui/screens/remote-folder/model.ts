// SSH server folder picker and recent folders: the pure part (strict decoders, folder-name rules, breadcrumbs, the
// open flow) and two small observable models. The host commands (`remote_ssh_workspace_*`) are reached through an
// injected io, so every branch is tested with no host and no ssh. No React here.
//
// Rules:
// - the server is the authority for paths: the webview only sends a path it was given (or `~`), never a typed one.
// - opening a folder is three steps in this order: the host opens it, the server core registers it, the shell refreshes
//   its project. A registration failure does not undo the open.
// - a folder that is outside the home folder is listed but never entered or selected (the host refuses it too).

import { Store } from "../settings/store.ts";
import { validateProjectName } from "../welcome/model.ts";
import { beginServerFolderOpen, endServerFolderOpen, type ProjectInfo } from "../shell/host.ts";
import { isRecord } from "../../kit/src/decode.ts";
import { entryNameProblem } from "../../kit/src/entry-name.ts";
import { hostErrorCode, hostErrorText } from "../../kit/src/host-error.ts";
import { joinAbs } from "../../kit/src/paths.ts";

/** One folder as the host lists it. The host lists folders only. */
export interface RemoteEntry {
  name: string;
  /** A symbolic link. */
  isLink: boolean;
  /** The link points outside the home folder: shown, never enterable. */
  outsideHome: boolean;
}

export interface RemoteListing {
  /** The canonical absolute path that was listed (`~` resolves to the home folder). */
  path: string;
  entries: RemoteEntry[];
}

/** The open server folder, as `remote_ssh_workspace_open` answers it (the same shape as a local project). */
export type RemoteProject = ProjectInfo;

/** The host commands the picker and the recent list use. */
export interface WorkspaceIo {
  listDirs(path: string, hidden: boolean): Promise<RemoteListing>;
  mkdir(path: string, name: string): Promise<{ path: string }>;
  /** Creates a project folder named `name` inside `parent` and answers it as the open folder. */
  createProject(parent: string, name: string): Promise<RemoteProject>;
  open(path: string): Promise<RemoteProject>;
  close(): Promise<void>;
  recent(): Promise<string[]>;
  forget(path: string): Promise<void>;
}

/** The host's invoke, narrowed to what this module uses (tests pass a fake). */
export type WorkspaceInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export const ROOT_MISSING_TEXT = "This folder is no longer on the server.";
export const LOST_CONNECTION_TEXT = "The connection to the server was lost.";
const DECODE_TEXT = "the desktop host returned a server folder answer this app cannot read";

// "." and ".." are not folders the picker can list or enter; a name with a slash is not a single path segment.
const validName = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v !== "." && v !== ".." && !v.includes("/");

/** Strict decode of `remote_ssh_workspace_list_dirs`; one malformed entry makes the whole answer unreadable. */
export function decodeListing(raw: unknown): RemoteListing | null {
  if (!isRecord(raw) || typeof raw.path !== "string" || !raw.path.startsWith("/") || !Array.isArray(raw.entries)) return null;
  const entries: RemoteEntry[] = [];
  for (const item of raw.entries) {
    if (!isRecord(item) || !validName(item.name) || typeof item.isLink !== "boolean" || typeof item.outsideHome !== "boolean") return null;
    entries.push({ name: item.name, isLink: item.isLink, outsideHome: item.outsideHome });
  }
  return { path: raw.path, entries };
}

/** Strict decode of `remote_ssh_workspace_open`. */
export function decodeRemoteProject(raw: unknown): RemoteProject | null {
  if (!isRecord(raw) || typeof raw.name !== "string" || typeof raw.root !== "string" || raw.root.length === 0) return null;
  return { name: raw.name, root: raw.root };
}

/** Strict decode of `remote_ssh_workspace_recent`: absolute paths only. */
export function decodeRecentPaths(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  for (const item of raw) {
    if (typeof item !== "string" || !item.startsWith("/")) return null;
  }
  return [...raw];
}

/** Strict decode of `remote_ssh_workspace_mkdir`. */
export function decodeMkdirResult(raw: unknown): { path: string } | null {
  if (!isRecord(raw) || typeof raw.path !== "string" || raw.path.length === 0) return null;
  return { path: raw.path };
}

function decodeOrThrow<T>(raw: unknown, decode: (v: unknown) => T | null): T {
  const value = decode(raw);
  if (value === null) throw new Error(DECODE_TEXT);
  return value;
}

/** The production io over the host's invoke. Commands and argument names are the contract's. */
export function createWorkspaceIo(invoke: WorkspaceInvoke): WorkspaceIo {
  return {
    async listDirs(path, hidden) {
      return decodeOrThrow(await invoke("remote_ssh_workspace_list_dirs", { path, hidden }), decodeListing);
    },
    async mkdir(path, name) {
      return decodeOrThrow(await invoke("remote_ssh_workspace_mkdir", { path, name }), decodeMkdirResult);
    },
    async createProject(parent, name) {
      return decodeOrThrow(await invoke("remote_ssh_project_create", { parent, name }), decodeRemoteProject);
    },
    async open(path) {
      return decodeOrThrow(await invoke("remote_ssh_workspace_open", { path }), decodeRemoteProject);
    },
    async close() {
      await invoke("remote_ssh_workspace_close");
    },
    async recent() {
      return decodeOrThrow(await invoke("remote_ssh_workspace_recent"), decodeRecentPaths);
    },
    async forget(path) {
      await invoke("remote_ssh_workspace_forget", { path });
    },
  };
}

/** The host's error code (`{ code, message }`), or "" when the error has none. */
export const workspaceErrorCode = hostErrorCode;

const CODE_TEXT: Record<string, string> = {
  root_missing: ROOT_MISSING_TEXT,
  lost_connection: LOST_CONNECTION_TEXT,
  outside_home: "That folder is outside your home folder.",
  invalid_path: "That path is not valid on the server.",
  not_found: "That folder was not found on the server.",
  no_project: "Open a folder on the server first.",
};

/** The sentence a user reads for a host error. Known codes have fixed text; any other shows the host's message. */
export function workspaceErrorText(e: unknown): string {
  return hostErrorText(e, CODE_TEXT, "The server request failed.");
}

/**
 * A new folder's name. Refused here before the host is asked, because each of these is a path the host would reject or
 * a name that cannot be typed back. Surrounding spaces are removed, as the host receives the trimmed name.
 */
export function folderNameError(raw: string): string | null {
  switch (entryNameProblem(raw)) {
    case "empty": return "Enter a folder name.";
    case "dot": return "Choose another name.";
    case "separator": return "A folder name cannot contain /.";
    case "null": return "A folder name cannot contain a null character.";
    case "line_break": return "A folder name cannot contain a line break.";
    default: return null;
  }
}

export { joinAbs };

/** Entries sorted case-insensitively; the exact name breaks a tie so the order is stable. */
export function sortEntries<T extends { name: string }>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export interface Crumb {
  label: string;
  path: string;
}

/**
 * The breadcrumbs for a listed folder: `~` for the home folder, then one crumb per segment below it. A path outside
 * the home folder (not reachable from the picker) starts at `/`, so the user still sees where it is.
 */
export function breadcrumbsFor(path: string, home: string | null): Crumb[] {
  if (home !== null) {
    const prefix = home.endsWith("/") ? home : `${home}/`;
    if (path === home || path.startsWith(prefix)) {
      const crumbs: Crumb[] = [{ label: "~", path: home }];
      let acc = home;
      for (const seg of path.slice(path === home ? home.length : prefix.length).split("/").filter(Boolean)) {
        acc = joinAbs(acc, seg);
        crumbs.push({ label: seg, path: acc });
      }
      return crumbs;
    }
  }
  const crumbs: Crumb[] = [{ label: "/", path: "/" }];
  let acc = "";
  for (const seg of path.split("/").filter(Boolean)) {
    acc = `${acc}/${seg}`;
    crumbs.push({ label: seg, path: acc });
  }
  return crumbs;
}

/** The text of a registration failure, for the notice. Host text is cut short; an empty message reads as unknown. */
function reasonOf(e: unknown): string {
  const message = isRecord(e) && typeof e.message === "string" ? e.message : e instanceof Error ? e.message : String(e);
  return message.trim().slice(0, 160) || "unknown error";
}

/** The three steps that make a server folder the project. Each is injected, so the order is tested directly. */
export interface OpenFlowDeps {
  /**
   * Asks the unsaved-work question before the folder changes (the shell's project store). Resolves `cancelled` when the
   * user stays. Omitted in tests: the action then runs at once.
   */
  guard?<T>(cancelled: T, action: () => Promise<T>): Promise<T>;
  /** Registers the root with the server core. Throws when the core refuses. */
  register(root: string): Promise<void>;
  /** Re-reads the active project from the host. */
  refresh(): Promise<void>;
  /** Shows a non-blocking notice on the shell. */
  announce(text: string): void;
}

/**
 * Open a folder on the server as the project: the unsaved-work question first (when the guard is given), then the host
 * opens it, the core registers it, and the shell refreshes. Null when the user stays in the current folder. A
 * registration failure is announced and the open stands. An open failure throws the host's error unchanged.
 */
export async function openServerFolder(io: WorkspaceIo, path: string, deps: OpenFlowDeps): Promise<RemoteProject | null> {
  const guard = deps.guard ?? (<T>(_cancelled: T, action: () => Promise<T>) => action());
  return guard<RemoteProject | null>(null, async () => {
    // The host gate ignores a root_missing from a call still in flight while the folder changes (see host.ts).
    beginServerFolderOpen();
    let project: RemoteProject;
    try {
      project = await io.open(path);
    } finally {
      endServerFolderOpen();
    }
    try {
      await deps.register(project.root);
    } catch (e) {
      deps.announce(`Opened, but the server did not register the project: ${reasonOf(e)}`);
    }
    await deps.refresh();
    return project;
  });
}

/** What "the server folder is gone" needs: close the folder on the host, say why, and re-read the project. */
export interface LeaveDeps {
  io: Pick<WorkspaceIo, "close">;
  announce(text: string): void;
  refresh(): Promise<void>;
}

// Several Explorer calls can fail with root_missing at once. They share one return to the home page.
let leaving: Promise<void> | null = null;

/** Return to the server home after the open folder vanished. Concurrent calls share one run. */
export function leaveRemoteFolder(deps: LeaveDeps, message: string): Promise<void> {
  if (leaving) return leaving;
  leaving = (async () => {
    try {
      await deps.io.close();
    } catch {
      // The host may have dropped the folder already; the return home happens either way.
    }
    deps.announce(message);
    await deps.refresh();
  })().finally(() => {
    leaving = null;
  });
  return leaving;
}

/** The new-project flow's extra dependency: the core registration, which returns its warnings (see `registerNewProject`). */
export interface NewProjectDeps {
  /** Registers the created project with the core and installs the skills kit. Resolves the warnings to show (none when clean). */
  registerNew(project: RemoteProject): Promise<string[]>;
}

/** Everything the picker needs: the open flow's steps and the new project's registration. */
export type PickerDeps = OpenFlowDeps & NewProjectDeps;

/** A project that was created, opened and refreshed, but whose registration gave warnings. Try again reruns only the registration. */
export interface PendingProject {
  project: RemoteProject;
  warnings: string[];
}

/** A created project, plus the shell refresh's failure. The project is open either way, so the refresh error is shown apart. */
export interface CreatedProject extends PendingProject {
  /** The refresh failure's text, or null when the shell refreshed. */
  refreshError: string | null;
}

/** Runs the registration step. A throw becomes one warning, so the created project is never lost to it. */
async function registerNewOrWarn(deps: NewProjectDeps, project: RemoteProject): Promise<string[]> {
  try {
    return await deps.registerNew(project);
  } catch (e) {
    return [`It could not be registered with the core yet (${reasonOf(e)}). Doc Gen registers it when you open it.`];
  }
}

/**
 * Create a project folder inside the listed folder, then open it: the unsaved-work question first (when the guard is
 * given), then the host creates it, the core registers it (warnings only), and the shell refreshes. Null when the user
 * stays. A create failure throws the host's error unchanged, and nothing is opened. A refresh failure does not throw:
 * the project is already open, so it is reported in `refreshError`.
 */
export async function createServerProject(
  io: WorkspaceIo,
  parent: string,
  name: string,
  deps: PickerDeps,
): Promise<CreatedProject | null> {
  const guard = deps.guard ?? (<T>(_cancelled: T, action: () => Promise<T>) => action());
  return guard<CreatedProject | null>(null, async () => {
    // Same gate as the open: a root_missing from a call still in flight must not close the new folder.
    beginServerFolderOpen();
    let project: RemoteProject;
    try {
      project = await io.createProject(parent, name);
    } finally {
      endServerFolderOpen();
    }
    const warnings = await registerNewOrWarn(deps, project);
    let refreshError: string | null = null;
    try {
      await deps.refresh();
    } catch (e) {
      refreshError = reasonOf(e);
    }
    return { project, warnings, refreshError };
  });
}

export const PICKER_INITIAL = {
  home: null,
  path: null,
  entries: [],
  showHidden: false,
  selected: null,
  loading: false,
  error: null,
  busy: false,
  creating: false,
  newName: "",
  newNameError: null,
  creatingProject: false,
  newProjectName: "",
  newProjectError: null,
  pending: null,
} as const satisfies PickerState;

export interface PickerState {
  /** The home folder, learned from the first listing of `~`. */
  home: string | null;
  /** The folder being listed (canonical). */
  path: string | null;
  entries: RemoteEntry[];
  showHidden: boolean;
  /** The selected entry's name. */
  selected: string | null;
  loading: boolean;
  /** A listing or open error, shown inline (host text, already turned into a sentence). */
  error: string | null;
  /** An open or create is running. */
  busy: boolean;
  /** The New folder name field is open. */
  creating: boolean;
  newName: string;
  newNameError: string | null;
  /** The New project name field is open. */
  creatingProject: boolean;
  newProjectName: string;
  newProjectError: string | null;
  /** A created project whose registration gave warnings: shown with Try again and Continue; the other actions wait. */
  pending: PendingProject | null;
}

/** The folder picker. Navigation stays inside what the host lists; every answer is checked against the current path. */
export class FolderPickerModel extends Store<PickerState> {
  readonly #io: WorkspaceIo;
  readonly #deps: PickerDeps;
  /** Bumped by every listing. A listing that finishes after a newer one started is dropped. */
  #generation = 0;

  constructor(io: WorkspaceIo, deps: PickerDeps) {
    super({ ...PICKER_INITIAL, entries: [] });
    this.#io = io;
    this.#deps = deps;
  }

  /** Lists the home folder. */
  start(): Promise<void> {
    return this.#list("~");
  }

  /** Enters a listed folder. An outside-home link is refused here, as the host refuses it. */
  enter(name: string): Promise<void> {
    const s = this.getState();
    const entry = s.entries.find((e) => e.name === name);
    if (!entry || entry.outsideHome || s.path === null) return Promise.resolve();
    return this.#list(joinAbs(s.path, name));
  }

  /** Goes to a breadcrumb. */
  goTo(path: string): Promise<void> {
    return this.#list(path);
  }

  /** Selects a listed folder. Outside-home folders cannot be selected. */
  select(name: string): void {
    const entry = this.getState().entries.find((e) => e.name === name);
    if (!entry || entry.outsideHome) return;
    this.set({ selected: name });
  }

  toggleHidden(): Promise<void> {
    this.set({ showHidden: !this.getState().showHidden });
    return this.#list(this.getState().path ?? "~");
  }

  startNewFolder(): void {
    this.set({ creating: true, newName: "", newNameError: null, creatingProject: false, newProjectError: null });
  }

  cancelNewFolder(): void {
    this.set({ creating: false, newName: "", newNameError: null });
  }

  setNewName(value: string): void {
    this.set({ newName: value, newNameError: null });
  }

  startNewProject(): void {
    this.set({ creatingProject: true, newProjectName: "", newProjectError: null, creating: false, newNameError: null });
  }

  cancelNewProject(): void {
    this.set({ creatingProject: false, newProjectName: "", newProjectError: null });
  }

  setNewProjectName(value: string): void {
    this.set({ newProjectName: value, newProjectError: null });
  }

  /**
   * Creates a project folder named by the field, inside the listed folder (the server home included), and opens it.
   * Resolves the project when it is open and registered cleanly; null when the user stays, the create is refused (the
   * error shows in the field), registration gave warnings (see `pending`), or the refresh failed (the general `error`
   * says so). The project is open in every case after the create succeeds.
   */
  async createProject(): Promise<RemoteProject | null> {
    const s = this.getState();
    if (s.busy || s.path === null || s.pending !== null) return null;
    // Same rules as the local New project (reserved names, bad characters, length), not just the folder-name check.
    const check = validateProjectName(s.newProjectName);
    if (!check.ok) {
      this.set({ newProjectError: check.error });
      return null;
    }
    const name = check.name;
    this.set({ busy: true, newProjectError: null });
    try {
      const created = await createServerProject(this.#io, s.path, name, this.#deps);
      if (created === null) return null;
      this.set({ creatingProject: false, newProjectName: "" });
      if (created.refreshError !== null) {
        // The name field is closed: the folder exists, so another create with the same name would only be refused.
        this.set({ error: `The project was created and opened, but the app could not refresh: ${created.refreshError}` });
      }
      if (created.warnings.length > 0) {
        this.set({ pending: { project: created.project, warnings: created.warnings } });
        return null;
      }
      return created.refreshError === null ? created.project : null;
    } catch (e) {
      this.set({ newProjectError: workspaceErrorText(e) });
      return null;
    } finally {
      this.set({ busy: false });
    }
  }

  /** Reruns only the registration of the pending project. Resolves the project when it is clean now, else null. */
  async retryRegistration(): Promise<RemoteProject | null> {
    const pending = this.getState().pending;
    if (pending === null || this.getState().busy) return null;
    this.set({ busy: true });
    try {
      const warnings = await registerNewOrWarn(this.#deps, pending.project);
      if (warnings.length === 0) {
        this.set({ pending: null });
        return pending.project;
      }
      this.set({ pending: { project: pending.project, warnings } });
      return null;
    } finally {
      this.set({ busy: false });
    }
  }

  /** Leaves the pending project as it is (its registration warnings are dropped). Resolves the open project. */
  keepPendingProject(): RemoteProject | null {
    const pending = this.getState().pending;
    if (pending === null) return null;
    this.set({ pending: null });
    return pending.project;
  }

  /**
   * Creates the named folder in the listed folder, then lists it again and selects the new folder. A name starting with
   * a dot turns on Show hidden first, so the new folder is visible to select.
   */
  async createFolder(): Promise<void> {
    const s = this.getState();
    if (s.busy || s.path === null) return;
    const error = folderNameError(s.newName);
    if (error !== null) {
      this.set({ newNameError: error });
      return;
    }
    const name = s.newName.trim();
    this.set({ busy: true, newNameError: null });
    try {
      await this.#io.mkdir(s.path, name);
      if (name.startsWith(".") && !this.getState().showHidden) this.set({ showHidden: true });
      this.set({ creating: false, newName: "" });
      await this.#list(s.path);
      this.select(name);
    } catch (e) {
      this.set({ newNameError: workspaceErrorText(e) });
    } finally {
      this.set({ busy: false });
    }
  }

  /** Makes the listed folder the project. Returns it, or null when the open failed or was not confirmed (see `error`). */
  openCurrent(): Promise<RemoteProject | null> {
    const s = this.getState();
    if (s.path === null) return Promise.resolve(null);
    return this.#open(s.path);
  }

  /**
   * Makes the selected entry the project (Open). Double-click navigates instead; this is the only way to open an entry.
   * Null with no selection, or when the selected folder cannot be opened (the error is shown).
   */
  openSelected(): Promise<RemoteProject | null> {
    const s = this.getState();
    const entry = s.entries.find((e) => e.name === s.selected);
    if (s.path === null || !entry || entry.outsideHome) return Promise.resolve(null);
    return this.#open(joinAbs(s.path, entry.name));
  }

  async #open(path: string): Promise<RemoteProject | null> {
    if (this.getState().busy || this.getState().pending !== null) return null;
    this.set({ busy: true, error: null });
    try {
      return await openServerFolder(this.#io, path, this.#deps);
    } catch (e) {
      this.set({ error: workspaceErrorText(e) });
      return null;
    } finally {
      this.set({ busy: false });
    }
  }

  async #list(path: string): Promise<void> {
    const generation = ++this.#generation;
    this.set({ loading: true, error: null });
    try {
      const listing = await this.#io.listDirs(path, this.getState().showHidden);
      if (generation !== this.#generation) return;
      // The first listing of `~` is the home folder; every later listing keeps it.
      const home = path === "~" ? listing.path : this.getState().home;
      this.set({ home, path: listing.path, entries: sortEntries(listing.entries), selected: null, loading: false });
    } catch (e) {
      if (generation !== this.#generation) return;
      this.set({ loading: false, error: workspaceErrorText(e) });
    }
  }
}

export interface RecentState {
  /** Recent folder paths, most recent first, as the host keeps them. */
  paths: string[];
  /** Paths that could not be opened because the server no longer has them: shown greyed, with Remove. */
  missing: string[];
  busy: boolean;
  error: string | null;
}

/** The recent folders on this server. */
export class ServerRecentModel extends Store<RecentState> {
  readonly #io: WorkspaceIo;
  readonly #deps: OpenFlowDeps;

  constructor(io: WorkspaceIo, deps: OpenFlowDeps) {
    super({ paths: [], missing: [], busy: false, error: null });
    this.#io = io;
    this.#deps = deps;
  }

  async load(): Promise<void> {
    try {
      const paths = await this.#io.recent();
      this.set({ paths, error: null });
    } catch (e) {
      this.set({ error: workspaceErrorText(e) });
    }
  }

  /** Opens a recent folder. A folder the server no longer has is marked missing instead of failing the page. */
  async open(path: string): Promise<RemoteProject | null> {
    this.set({ busy: true, error: null });
    try {
      const project = await openServerFolder(this.#io, path, this.#deps);
      this.set({ missing: this.getState().missing.filter((p) => p !== path) });
      return project;
    } catch (e) {
      const code = workspaceErrorCode(e);
      if (code === "not_found" || code === "root_missing") {
        const missing = this.getState().missing;
        this.set({ missing: missing.includes(path) ? missing : [...missing, path] });
      } else {
        this.set({ error: workspaceErrorText(e) });
      }
      return null;
    } finally {
      this.set({ busy: false });
    }
  }

  /** Removes one folder from the recent list on the server. */
  async forget(path: string): Promise<void> {
    try {
      await this.#io.forget(path);
      this.set({ missing: this.getState().missing.filter((p) => p !== path), error: null });
      await this.load();
    } catch (e) {
      this.set({ error: workspaceErrorText(e) });
    }
  }
}
