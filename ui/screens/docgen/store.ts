// Doc Gen / Visual screen state: project registration with the core, templates and commands, the current choice,
// the source selection, and the generation run. A plain observable store (no React); `useSyncExternalStore` reads it.
import { describeFailure, isCancel, type Failure } from "./errors.ts";
import { folderForName, projectIdFor, type DocsApi } from "./docs-api.ts";
import type { DocCommand, DocTemplate, Surface } from "./model.ts";
import { GenerationRun, type RunDeps } from "./run.ts";
import { SourceSelection, type SourceItem } from "./sources.ts";

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
}

export interface StoreDeps {
  surface: Surface;
  /** Builds the core calls for a project. Tests pass fakes. */
  makeApi: (projectId: string, root: string) => DocsApi;
  run: Omit<RunDeps, "api">;
  idFor?: (root: string) => Promise<string>;
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
};

export class DocGenStore {
  readonly surface: Surface;
  readonly run: GenerationRun;
  private state: DocGenState = EMPTY;
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
  }

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getSnapshot = (): DocGenState => this.state;

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
    if (!root) {
      this.set({ ...EMPTY });
      return;
    }
    this.set({ ...EMPTY, setup: "loading" });
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
      const api = this.deps.makeApi(id, root);
      await api.register(ctl.signal);
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

  /** Create or update a project template through the core. Resolves to the saved template, or null on failure. */
  async saveTemplate(input: { folder: string | null; name: string; sections: string[] }): Promise<DocTemplate | null> {
    const folder = input.folder ?? folderForName(input.name);
    if (!folder) {
      this.set({ templateError: { message: "Use a name with letters or numbers.", retryable: false, action: "none" } });
      return null;
    }
    this.set({ templateBusy: true, templateError: null });
    try {
      const saved = await this.requireApi().putTemplate(folder, { name: input.name.trim(), sections: input.sections, surface: this.surface });
      const others = this.state.templates.filter((t) => t.folderName !== saved.folderName);
      this.set({ templateBusy: false, templates: [...others, saved].sort((a, b) => a.name.localeCompare(b.name)), templateId: saved.id });
      return saved;
    } catch (e) {
      this.set({ templateBusy: false, templateError: describeFailure(e) });
      return null;
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

  /** Start a generation from the current choice and selection. */
  generate(): Promise<void> {
    const s = this.state;
    return this.run.generate({ template: this.template, command: s.command, prompt: s.prompt }, s.selection.items());
  }

  dispose(): void {
    this.ctl?.abort();
    this.run.cancel();
    this.listeners.clear();
  }
}
