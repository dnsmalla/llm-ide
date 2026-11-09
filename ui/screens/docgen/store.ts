// Doc Gen / Visual screen state: project registration with the core, templates and commands, the current choice,
// the source selection, and the generation run. A plain observable store (no React); `useSyncExternalStore` reads it.
import { describeFailure, isCancel, type Failure } from "./errors.ts";
import { FOLDER_RE, folderForName, projectIdFor, type DocsApi } from "./docs-api.ts";
import { templateImportText } from "./template-file.ts";
import { CHAT_ONLY_COMMAND, type DocCommand, type DocTemplate, type Surface } from "./model.ts";
import { GenerationRun, type RunDeps } from "./run.ts";
import { SourceSelection, type SourceItem } from "./sources.ts";
import { GENERATED_DIR, normalizeDestination } from "./naming.ts";

export type SetupPhase = "no_project" | "loading" | "ready" | "error";

export interface DocGenState {
  setup: SetupPhase;
  setupError: Failure | null;
  templates: readonly DocTemplate[];
  commands: readonly DocCommand[];
  /** The core lists at most 2,000 template folders; more exist when true. */
  truncated: boolean;
  templateId: string | null;
  /** The saved command picked from the list, or null for free text. */
  commandId: string | null;
  command: string;
  prompt: string;
  selection: SourceSelection;
  /** One-line notice about the last selection change (cap reached, nothing added...). */
  selectionNote: string | null;
  /** A template write/delete is in flight, or its failure. */
  templateBusy: boolean;
  templateError: Failure | null;
  /** Project-relative folder new documents are saved in (Mac Setup destination). */
  destination: string;
  /** The chat reply last written by "Save chat output" and where it went; null before the first save. */
  chatSaved: { reply: string; path: string } | null;
  /** A failed "Save chat output" write. */
  chatSaveError: Failure | null;
}

export interface StoreDeps {
  surface: Surface;
  /** Builds the core calls for a project. Tests pass fakes. */
  makeApi: (projectId: string, root: string) => DocsApi;
  run: Omit<RunDeps, "api">;
  idFor?: (root: string) => Promise<string>;
}

/** PUTs a new template or command folder may take (the first guess plus 409 retries) before the plain error. */
const CREATE_ATTEMPTS = 50;

/** The folder for suffix index n (1 is the plain name, 2 is `name-2`...); null when it is not a valid folder name. */
function folderAt(base: string, n: number): string | null {
  const suffix = n === 1 ? "" : `-${n}`;
  const folder = `${base.slice(0, 80 - suffix.length).replace(/-+$/, "")}${suffix}`;
  return FOLDER_RE.test(folder) ? folder : null;
}

const EMPTY: DocGenState = {
  setup: "no_project",
  setupError: null,
  templates: [],
  commands: [],
  truncated: false,
  templateId: null,
  commandId: null,
  command: "",
  prompt: "",
  selection: new SourceSelection(),
  selectionNote: null,
  templateBusy: false,
  templateError: null,
  destination: GENERATED_DIR,
  chatSaved: null,
  chatSaveError: null,
};

export class DocGenStore {
  readonly surface: Surface;
  readonly run: GenerationRun;
  private state: DocGenState;
  private readonly listeners = new Set<() => void>();
  private api: DocsApi | null = null;
  private root: string | null = null;
  private loadToken = 0;
  private ctl: AbortController | null = null;
  private readonly deps: StoreDeps;
  private readonly apiProxy: Pick<DocsApi, "generate">;

  constructor(deps: StoreDeps) {
    this.deps = deps;
    this.surface = deps.surface;
    this.apiProxy = { generate: (b, s) => this.requireApi().generate(b, s) };
    this.run = new GenerationRun({ ...deps.run, api: this.apiProxy });
    // The UI shows the same folder the run saves into (the shell passes the remembered Setup folder).
    this.state = { ...EMPTY, destination: normalizeDestination(deps.run.destination ?? GENERATED_DIR) };
  }

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getSnapshot = (): DocGenState => this.state;

  setDestination(dir: string): void {
    this.run.setDestination(dir);
    this.set({ destination: normalizeDestination(dir) });
  }

  /**
   * "Save chat output": writes the chat's latest reply as its own file, never as the document. The same reply is
   * not written twice (the button stays off until a different reply arrives), as on the Mac.
   */
  async saveChatReply(text: string): Promise<void> {
    // A second press while the first write is still in flight would otherwise write the same reply twice.
    if (text.trim() === "" || this.state.chatSaved?.reply === text || this.chatSaving === text) return;
    this.chatSaving = text;
    try {
      const saved = await this.run.saveChatReply(text);
      this.set({ chatSaved: { reply: text, path: saved.path }, chatSaveError: null });
    } catch (e) {
      this.set({ chatSaveError: describeFailure(e) });
    } finally {
      if (this.chatSaving === text) this.chatSaving = null;
    }
  }
  private chatSaving: string | null = null;

  private set(p: Partial<DocGenState>): void {
    this.state = { ...this.state, ...p };
    for (const l of [...this.listeners]) l();
  }

  private requireApi(): DocsApi {
    if (!this.api) throw Object.assign(new Error("no project"), { code: "no_project" });
    return this.api;
  }

  get currentRoot(): string | null {
    return this.root;
  }

  /** Point the screen at a project (or none). A new root resets the selection, the run and the template choice. */
  async setProject(root: string | null): Promise<void> {
    if (root === this.root && this.state.setup !== "no_project") return;
    this.ctl?.abort();
    this.run.reset();
    this.root = root;
    this.api = null;
    // The Setup folder is a preference, not part of the project's work: it survives a project switch.
    const destination = this.state.destination;
    if (!root) {
      this.set({ ...EMPTY, destination });
      return;
    }
    this.set({ ...EMPTY, destination, setup: "loading" });
    await this.load();
  }

  /** (Re)register the project and list templates and commands. */
  async load(): Promise<void> {
    const root = this.root;
    if (!root) return;
    const my = ++this.loadToken;
    this.ctl?.abort();
    const ctl = new AbortController();
    this.ctl = ctl;
    this.set({ setup: "loading", setupError: null });
    try {
      const id = await (this.deps.idFor ?? projectIdFor)(root);
      let api = this.deps.makeApi(id, root);
      // R-021 #4: a new project gets a server-issued id; adopt it for every later call on this project.
      const registered = await api.register(ctl.signal);
      if (registered.id !== id) api = this.deps.makeApi(registered.id, root);
      // First use of a project: write the kit's default templates and commands (write-if-absent, never overwrites).
      let [t, c] = await Promise.all([api.templates(ctl.signal), api.commands(ctl.signal)]);
      if (my !== this.loadToken) return;
      if (t.items.length === 0 && c.items.length === 0) {
        await api.seed(ctl.signal);
        [t, c] = await Promise.all([api.templates(ctl.signal), api.commands(ctl.signal)]);
        if (my !== this.loadToken) return;
      }
      this.api = api;
      const templates = t.items.filter((x) => x.surface === this.surface);
      const commands = c.items.filter((x) => x.surface === this.surface);
      const keep = templates.find((x) => x.id === this.state.templateId);
      this.set({ setup: "ready", templates, commands, truncated: t.truncated || c.truncated, templateId: keep ? keep.id : null });
    } catch (e) {
      if (my !== this.loadToken || isCancel(e)) return;
      this.set({ setup: "error", setupError: describeFailure(e) });
    }
  }

  get template(): DocTemplate | null {
    return this.state.templates.find((t) => t.id === this.state.templateId) ?? null;
  }

  selectTemplate(id: string | null): void {
    this.set({ templateId: id !== null && this.state.templates.some((t) => t.id === id) ? id : null });
  }
  selectCommand(id: string | null): void {
    const c = id === null ? null : this.state.commands.find((x) => x.id === id) ?? null;
    this.set({ commandId: c ? c.id : null, command: c ? c.instruction : this.state.command });
  }
  setCommandText(text: string): void {
    // Editing a saved command's text makes it a custom one.
    this.set({ command: text, commandId: null });
  }
  setPrompt(text: string): void {
    this.set({ prompt: text });
  }

  addItems(items: readonly SourceItem[]): void {
    const r = this.state.selection.add(items);
    const added = r.selection.size - this.state.selection.size;
    const note = r.refused > 0 ? `Selection is full (5,000 sources); ${r.refused} not added.` : added === 0 && items.length > 0 ? "Those sources are already selected." : null;
    this.set({ selection: r.selection, selectionNote: note });
  }
  removeKeys(keys: Iterable<string>): void {
    this.set({ selection: this.state.selection.remove(keys), selectionNote: null });
  }
  clearSelection(): void {
    this.set({ selection: this.state.selection.clear(), selectionNote: null });
  }
  addPaste(text: string): boolean {
    const r = this.state.selection.addPaste(text);
    const note = r.reason === "too_long" ? "Pasted text is over 200,000 characters. Save it as a file and add the file." : r.reason === "cap" ? "Selection is full (5,000 sources)." : null;
    this.set({ selection: r.selection, selectionNote: note });
    return r.item !== null;
  }

  /**
   * Create or update a project template through the core. Resolves to the saved template, or null on failure.
   * A new template (folder null: create or import) takes the first free folder of its name: `name`, `name-2`, `name-3`,
   * as the Mac does; it never writes into a folder that already holds a template. Editing passes its own folder.
   * `rawContent` (an import) stores the whole file, with the surface marker stamped in, instead of a rendered body.
   */
  async saveTemplate(input: { folder: string | null; name: string; sections: string[]; rawContent?: string }): Promise<DocTemplate | null> {
    const base = input.folder ?? folderForName(input.name);
    if (!base) {
      this.set({ templateError: { message: "Use a name with letters or numbers.", retryable: false, action: "none" } });
      return null;
    }
    let text: string | undefined;
    if (input.rawContent !== undefined) {
      const stamped = templateImportText(input.rawContent, this.surface);
      if (stamped.kind === "error") {
        this.set({ templateError: { message: stamped.message, retryable: false, action: "none" } });
        return null;
      }
      text = stamped.text;
    }
    this.set({ templateBusy: true, templateError: null });
    try {
      const api = this.requireApi();
      const body = { name: input.name.trim(), sections: input.sections, surface: this.surface, rawContent: text };
      // A new template goes through createOnly: the core's 409 decides, so a folder the list skips is still safe.
      // Editing writes its own folder and never sends createOnly.
      const saved = input.folder !== null
        ? await api.putTemplate(input.folder, body)
        : await this.createFolder(base, await this.firstFreeTemplateIndex(base), "TEMPLATE_EXISTS", (f) => api.putTemplate(f, { ...body, createOnly: true }));
      if (saved === null) {
        this.set({ templateBusy: false, templateError: { message: `Too many templates already use the name ${base}. Rename one of them.`, retryable: false, action: "none" } });
        return null;
      }
      const others = this.state.templates.filter((t) => t.folderName !== saved.folderName);
      this.set({ templateBusy: false, templates: [...others, saved].sort((a, b) => a.name.localeCompare(b.name)), templateId: saved.id });
      return saved;
    } catch (e) {
      this.set({ templateBusy: false, templateError: describeFailure(e) });
      return null;
    }
  }

  /**
   * The first guess for a NEW template folder: the index of the first `base`, `base-2`, `base-3`... (the Mac's
   * uniqueFolderSlug) that the list does not show. Compared case-insensitively, as the core's folder match is.
   * The list is only a guess: it caps at 2,000 folders and skips unreadable ones, so the core's createOnly 409 is the
   * authority, and createFolder moves on from here when it clashes.
   */
  private async firstFreeTemplateIndex(base: string): Promise<number> {
    const existing = await this.requireApi().templates();
    const taken = new Set(existing.items.map((t) => t.folderName?.toLowerCase()).filter((f): f is string => Boolean(f)));
    let n = 1;
    while (taken.has(folderAt(base, n) ?? "")) n++;
    return n;
  }

  /**
   * Creates a NEW folder: `base` (index `start`), then the next suffixes while the core answers 409 with `existsCode`
   * (the folder exists, in any case). Any other error, and a 409 with another code, is thrown at once. Resolves to null
   * when CREATE_ATTEMPTS folders in a row are taken. Old cores ignore createOnly and answer 200, which is success here.
   */
  private async createFolder<T>(base: string, start: number, existsCode: string, put: (folder: string) => Promise<T>): Promise<T | null> {
    let n = start;
    for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt++, n++) {
      const folder = folderAt(base, n);
      if (folder === null) return null;
      try {
        return await put(folder);
      } catch (e) {
        const o = (typeof e === "object" && e !== null ? e : {}) as { status?: unknown; code?: unknown };
        if (o.status !== 409 || o.code !== existsCode) throw e;
      }
    }
    return null;
  }

  async saveCommand(input: { folder: string | null; name: string; instruction: string }): Promise<DocCommand | null> {
    const folder = input.folder ?? folderForName(input.name);
    if (!folder) {
      this.set({ templateError: { message: "Use a name with letters or numbers.", retryable: false, action: "none" } });
      return null;
    }
    if (input.instruction.trim() === "") {
      this.set({ templateError: { message: "A command needs an instruction.", retryable: false, action: "none" } });
      return null;
    }
    this.set({ templateBusy: true, templateError: null });
    try {
      const api = this.requireApi();
      const body = { name: input.name.trim(), instruction: input.instruction, surface: this.surface };
      // A new command: `folder` is the first guess and the core's createOnly 409 moves on to the next suffix.
      const saved = input.folder !== null
        ? await api.putCommand(input.folder, body)
        : await this.createFolder(folder, 1, "COMMAND_EXISTS", (f) => api.putCommand(f, { ...body, createOnly: true }));
      if (saved === null) {
        this.set({ templateBusy: false, templateError: { message: `Too many commands already use the name ${folder}. Rename one of them.`, retryable: false, action: "none" } });
        return null;
      }
      const others = this.state.commands.filter((c) => c.folderName !== saved.folderName);
      this.set({ templateBusy: false, commands: [...others, saved].sort((a, b) => a.name.localeCompare(b.name)), commandId: saved.id, command: saved.instruction });
      return saved;
    } catch (e) {
      this.set({ templateBusy: false, templateError: describeFailure(e) });
      return null;
    }
  }

  async deleteCommand(c: DocCommand): Promise<boolean> {
    if (!c.folderName || !c.isProjectCommand) return false;
    this.set({ templateBusy: true, templateError: null });
    try {
      await this.requireApi().deleteCommand(c.folderName);
      this.set({ templateBusy: false, commands: this.state.commands.filter((x) => x.id !== c.id), commandId: this.state.commandId === c.id ? null : this.state.commandId });
      return true;
    } catch (e) {
      this.set({ templateBusy: false, templateError: describeFailure(e) });
      return false;
    }
  }

  async deleteTemplate(t: DocTemplate): Promise<boolean> {
    if (!t.folderName || !t.isProjectTemplate) return false;
    this.set({ templateBusy: true, templateError: null });
    try {
      await this.requireApi().deleteTemplate(t.folderName);
      this.set({ templateBusy: false, templates: this.state.templates.filter((x) => x.id !== t.id), templateId: this.state.templateId === t.id ? null : this.state.templateId });
      return true;
    } catch (e) {
      this.set({ templateBusy: false, templateError: describeFailure(e) });
      return false;
    }
  }

  /**
   * Start a generation from the current choice and selection. `extra` is the chat reply (the only extra source).
   * A chat-only run has no template or command, so it sends CHAT_ONLY_COMMAND; the core would refuse it otherwise.
   */
  generate(extra: readonly SourceItem[] = []): Promise<void> {
    const s = this.state;
    const chatOnly = extra.length > 0 && !this.template && s.command.trim() === "";
    const command = chatOnly ? CHAT_ONLY_COMMAND : s.command;
    return this.run.generate({ template: this.template, command, prompt: s.prompt }, [...s.selection.items(), ...extra]);
  }

  dispose(): void {
    this.ctl?.abort();
    this.run.cancel();
    this.listeners.clear();
  }
}
