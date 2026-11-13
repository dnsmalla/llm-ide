// The generation run: one observable state machine for "read the sources, ask the core, hold the document, refine it,
// save it". No React, no network of its own (the core client, readers and fs are injected), so every transition is
// tested with node and fakes (no model call).
//
// Phases: idle -> reading -> generating -> done | error. Cancel returns a fresh run to idle and a refinement to the
// document it started from (a failed or cancelled revision never costs the user the document they had; same rule as
// the Mac app's GenerationViewModel). A late answer from a cancelled or superseded run is ignored.
import { describeFailure, isCancel, type Failure } from "./errors.ts";
import type { DocsApi } from "./docs-api.ts";
import { buildGenerateBody, estimateFit, fitNotice, MAX_SOURCE_CONTENT, type Selection } from "./model.ts";
import { documentStem, normalizeDestination } from "./naming.ts";
import { saveNewDocument, saveNewExternal, saveRevision, saveRevisionExternal, type ExternalSaver, type SaveFs, type Saved } from "./save.ts";
import { collectSources, sendOrder, type SourceItem, type SourceReaders } from "./sources.ts";

export type Phase = "idle" | "reading" | "generating" | "done" | "error";

export interface RunState {
  phase: Phase;
  /** Reading progress (sources read of total). */
  progress: { done: number; total: number } | null;
  /** Wall-clock start of the in-flight call, for an elapsed counter. */
  startedAt: number | null;
  /** The document (markdown). Empty until the first result. */
  doc: string;
  /** What the core could not fit, in words; null when everything went whole. */
  notice: string | null;
  /** Sources that could not be read as text. */
  skipped: string[];
  /** The same sources by unique key (`file:<rel>` / `note:<rel>`), for the source rows' markers. */
  skippedKeys: readonly string[];
  /** Sources left unread because the model's input was already full. */
  notRead: number;
  /** Terminal failure of a fresh run. */
  error: Failure | null;
  /** Failure of the LAST refinement only; the document is untouched. */
  editError: string | null;
  saved: (Saved & { stem: string }) | null;
  /** The document changed since it was last saved. */
  dirty: boolean;
  saving: boolean;
  saveError: Failure | null;
  /** The last save lost a compare-and-swap: offer "save as a new file". */
  saveConflict: boolean;
  revising: boolean;
}

/** A fresh Generate would throw away a finished document (and its refinements) that was never saved. */
export function replacesUnsavedDocument(s: RunState): boolean {
  return s.phase === "done" && s.dirty && s.doc.trim() !== "";
}

export const INITIAL_RUN: RunState = Object.freeze({
  phase: "idle",
  progress: null,
  startedAt: null,
  doc: "",
  notice: null,
  skipped: [],
  skippedKeys: [],
  notRead: 0,
  error: null,
  editError: null,
  saved: null,
  dirty: false,
  saving: false,
  saveError: null,
  saveConflict: false,
  revising: false,
});

export interface RunDeps {
  api: Pick<DocsApi, "generate">;
  readers: SourceReaders;
  fs: SaveFs;
  now?: () => number;
  today?: () => Date;
  /** Initial project-relative destination for new saves (Mac Setup). */
  destination?: string;
}

export const REVISION_SOURCE_NAME = "Current document (existing draft to revise — return the complete revised document, not a diff or fragment)";

function revisionPrompt(instruction: string): string {
  return `Revise the existing document below (attached as the source named "Current document") according to this instruction. Return the FULL revised document as your entire output — not a diff, not just the changed section, and no commentary before or after it.\n\nInstruction: ${instruction}`;
}

export class GenerationRun {
  private state: RunState = INITIAL_RUN;
  private readonly listeners = new Set<() => void>();
  private ctl: AbortController | null = null;
  private token = 0;
  private preRevision: string | null = null;
  private lastSelection: Selection | null = null;
  private destinationDir = "llm-doc/generated";
  private externalSaver: ExternalSaver | null = null;
  private externalName: string | null = null;
  private readonly deps: RunDeps;

  constructor(deps: RunDeps) {
    this.deps = deps;
    if (deps.destination) this.setDestination(deps.destination);
  }

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getSnapshot = (): RunState => this.state;

  private set(p: Partial<RunState>): void {
    this.state = { ...this.state, ...p };
    for (const l of [...this.listeners]) l();
  }

  get busy(): boolean {
    return this.state.phase === "reading" || this.state.phase === "generating";
  }

  /** Fresh generation from the selected sources. */
  async generate(sel: Selection, items: readonly SourceItem[]): Promise<void> {
    if (this.busy) return;
    const my = ++this.token;
    const ctl = new AbortController();
    this.ctl = ctl;
    this.preRevision = null;
    this.lastSelection = sel;
    const now = this.deps.now ?? Date.now;
    this.set({ ...INITIAL_RUN, phase: "reading", progress: { done: 0, total: items.length }, startedAt: now() });
    try {
      const read = await collectSources(items, this.deps.readers, ctl.signal, (p) => {
        if (my === this.token) this.set({ progress: { done: p.done, total: p.total } });
      });
      if (my !== this.token) return;
      if (read.sources.length === 0) {
        this.set({ phase: "error", progress: null, startedAt: null, skipped: read.skipped, skippedKeys: read.skippedKeys, error: { message: read.skipped.length ? "None of the selected sources could be read as text." : "There is nothing to generate from. Select text files or notes.", retryable: false, action: "none" } });
        return;
      }
      const built = buildGenerateBody(sel, read.sources);
      if (!built.ok) {
        this.set({ phase: "error", progress: null, startedAt: null, error: { message: built.message, retryable: false, action: "none" } });
        return;
      }
      this.set({ phase: "generating", progress: null, startedAt: now(), skipped: read.skipped, skippedKeys: read.skippedKeys, notRead: read.notRead });
      const r = await this.deps.api.generate(built.body, ctl.signal);
      if (my !== this.token) return;
      const notice = [fitNotice(r, read.sources.length), read.notRead > 0 ? `${read.notRead} more ${read.notRead === 1 ? "source was" : "sources were"} not read because the model's input was already full.` : null].filter(Boolean).join(" ") || null;
      this.set({ phase: "done", startedAt: null, doc: r.content, notice, dirty: true, saved: null, saveConflict: false, saveError: null });
    } catch (e) {
      if (my !== this.token) return;
      if (isCancel(e) || ctl.signal.aborted) {
        this.set({ phase: "idle", progress: null, startedAt: null });
        return;
      }
      this.set({ phase: "error", progress: null, startedAt: null, error: describeFailure(e) });
    } finally {
      if (this.ctl === ctl) this.ctl = null;
    }
  }

  /** Prompt-driven revision of the current document through the same route; keeps the template/command shape. */
  async refine(instruction: string): Promise<boolean> {
    const text = instruction.trim();
    if (this.busy || this.state.phase !== "done" || text === "") return false;
    const current = this.state.doc;
    if (current.length > MAX_SOURCE_CONTENT) {
      this.set({ editError: `This document is ${current.length.toLocaleString("en")} characters, over the ${MAX_SOURCE_CONTENT.toLocaleString("en")}-character limit for one revision. Save it and start a new document for further changes.` });
      return false;
    }
    const sel = this.lastSelection ?? { template: null, command: "", prompt: "" };
    // The core needs a template or a command for any request; a revision with neither uses a plain editing command.
    const hasShape = (sel.template !== null && sel.template.sections.length > 0) || sel.command.trim() !== "";
    const built = buildGenerateBody({ template: sel.template, command: hasShape ? sel.command : "Revise the document as instructed.", prompt: revisionPrompt(text) }, [{ name: REVISION_SOURCE_NAME, content: current }]);
    if (!built.ok) {
      this.set({ editError: built.message });
      return false;
    }
    const my = ++this.token;
    const ctl = new AbortController();
    this.ctl = ctl;
    this.preRevision = current;
    this.set({ phase: "generating", revising: true, editError: null, startedAt: (this.deps.now ?? Date.now)() });
    try {
      const r = await this.deps.api.generate(built.body, ctl.signal);
      if (my !== this.token) return false;
      if (r.truncatedCount > 0 || r.omittedCount > 0) {
        this.set({ phase: "done", revising: false, startedAt: null, editError: "The core could only read part of this document, so the revision would have replaced it with a shortened copy. The document is unchanged. Save it and start a new document for further changes." });
        return false;
      }
      this.set({ phase: "done", revising: false, startedAt: null, doc: r.content, notice: null, dirty: true, saveConflict: false, saveError: null });
      return true;
    } catch (e) {
      if (my !== this.token) return false;
      if (isCancel(e) || ctl.signal.aborted) {
        this.set({ phase: "done", revising: false, startedAt: null, doc: current });
        return false;
      }
      this.set({ phase: "done", revising: false, startedAt: null, doc: current, editError: describeFailure(e).message });
      return false;
    } finally {
      this.preRevision = null;
      if (this.ctl === ctl) this.ctl = null;
    }
  }

  /** Stops the in-flight call. A fresh run returns to idle; a revision restores the document it began with. */
  cancel(): void {
    const ctl = this.ctl;
    if (!ctl) return;
    this.token++; // anything still in flight is now stale
    ctl.abort();
    this.ctl = null;
    if (this.preRevision !== null) {
      const doc = this.preRevision;
      this.preRevision = null;
      this.set({ phase: "done", revising: false, startedAt: null, doc });
    } else {
      this.set({ phase: "idle", progress: null, startedAt: null });
    }
  }

  /** Back to the empty setup state (a running call is cancelled first). */
  reset(): void {
    this.cancel();
    this.token++;
    this.set({ ...INITIAL_RUN });
  }

  /** Project-relative folder for new saves (Mac's Setup destination). Empty/invalid falls back to the default. */
  setDestination(dir: string): void {
    this.destinationDir = normalizeDestination(dir);
    this.externalName = null;
  }

  /** Switch Save to the host-chosen folder (display name only), or back to the project folder. */
  setExternalDestination(name: string | null, saver?: ExternalSaver): void {
    if (saver) this.externalSaver = saver;
    this.externalName = name;
  }

  /** Writes a chat reply to `<destination>/chat-output.md` (or `-N`). Never touches the document state. */
  async saveChatReply(text: string): Promise<Saved> {
    if (this.externalName && this.externalSaver) return saveNewExternal(this.externalSaver, "chat-output", text);
    return saveNewDocument(this.deps.fs, "chat-output", text, this.destinationDir);
  }

  /** The user edited the document text by hand (the viewer is read-only; this serves paste-in and tests). */
  setDocument(text: string): void {
    if (this.busy || text === this.state.doc) return;
    this.set({ doc: text, dirty: true, saveConflict: false });
  }

  /** Save to `llm-doc/generated/`. First save creates a new file (never overwrites); later saves update it by hash. */
  async save(opts: { asNew?: boolean } = {}): Promise<void> {
    const s = this.state;
    if (s.saving || this.busy || s.doc.trim() === "") return;
    if (s.saved && !s.dirty && !opts.asNew) return;
    this.set({ saving: true, saveError: null, saveConflict: false });
    const my = this.token;
    try {
      let saved: Saved & { stem: string };
      if (this.externalName && this.externalSaver) {
        if (s.saved?.external && !opts.asNew) {
          const stem = s.saved.stem;
          saved = { ...(await saveRevisionExternal(this.externalSaver, s.saved.path.replace(/^external:/, ""), s.doc, s.saved.hash)), stem };
        } else {
          const sel = this.lastSelection;
          const stem = documentStem({ templateName: sel?.template?.name ?? null, commandName: null, date: (this.deps.today ?? (() => new Date()))() });
          saved = { ...(await saveNewExternal(this.externalSaver, stem, s.doc)), stem };
        }
      } else if (s.saved && !s.saved.external && !opts.asNew) {
        const r = await saveRevision(this.deps.fs, s.saved.path, s.doc, s.saved.hash);
        saved = { ...r, stem: s.saved.stem };
      } else {
        const sel = this.lastSelection;
        const stem = documentStem({ templateName: sel?.template?.name ?? null, commandName: null, date: (this.deps.today ?? (() => new Date()))() });
        const r = await saveNewDocument(this.deps.fs, stem, s.doc, this.destinationDir);
        saved = { ...r, stem };
      }
      if (my !== this.token) return;
      this.set({ saving: false, saved, dirty: false });
    } catch (e) {
      if (my !== this.token) return;
      const f = describeFailure(e);
      const conflict = typeof e === "object" && e !== null && (e as { code?: unknown }).code === "conflict";
      this.set({ saving: false, saveError: conflict ? { message: "The saved file was changed outside this app. Your text is kept here; save it as a new file to keep both.", retryable: false, action: "none" } : f, saveConflict: conflict });
    }
  }

  /** Rough pre-run input estimate for a selection (no reading). */
  static estimate(items: readonly SourceItem[], estimateChars: (bytes: number) => number): ReturnType<typeof estimateFit> {
    return estimateFit(sendOrder(items).map((i) => ({ name: i.name, chars: i.kind === "paste" ? i.bytes : estimateChars(i.bytes) })));
  }
}
