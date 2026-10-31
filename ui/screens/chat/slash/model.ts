// ComposerModel: everything the composer needs from "/", "@", skill chips and attachments, as a plain subscribable
// object (no React, no DOM), so it is tested with fakes. The React hook is a thin shell over it.
//
// Behaviour copied from the Mac's CompletionController: "/" opens on the draft's first character and the catalog
// loads when the menu OPENS; "@" opens on the last token; accepting a no-argument command suppresses one echo so
// Return-to-accept then Return-to-send works; the selection stays on the same ROW (by id) when data refreshes.
import type { AttachmentManager, WireAttachment } from "../attach/manager";
import { createCatalogLoader, type CatalogLoader, type CatalogSnapshot } from "./loader";
import { buildMentionView, buildCommandView, acceptOf, EMPTY_VIEW, MAX_SKILL_CHIPS, type Accept, type MenuView, type SkillChip } from "./menu";
import { buildModeItems, buildModelItems, type MenuItem, type ModeLike, type ModelGroupLike } from "./items";
import { detectTrigger, type Trigger } from "./trigger";
import { parseBuiltin, type BuiltinCall } from "./builtins";
import type { MentionResult, MentionSearch } from "../mentions";
import { safeMentionPath } from "../mentions/paths";

export interface ComposerActions {
  setDraft(text: string): void;
  setMode(id: string): void;
  setModel(provider: string, model: string): void;
  /** Open a Library row (hook / MCP). */
  navigate(target: { kind: "plugin" | "mcp"; id: string }): void;
}

export interface ComposerSources {
  modes(): readonly ModeLike[];
  models(): readonly ModelGroupLike[];
}

export interface ComposerState {
  open: boolean;
  trigger: Trigger | null;
  view: MenuView;
  loading: boolean;
  /** A line under the list ("Still indexing...", "No such folder"). */
  note: string | null;
  skills: readonly SkillChip[];
  /** Short error/notice for the user (a refused file, too many skills). */
  message: string | null;
}

export interface SendPayload {
  /** Text with skill directives prepended (and attachments' effect nowhere else). */
  text: string;
  skills: string[] | undefined;
  attachments: WireAttachment[] | undefined;
}

export interface ModelDeps {
  catalog: CatalogLoader;
  sources: ComposerSources;
  actions: ComposerActions;
  attachments: AttachmentManager | null;
  mentions: MentionSearch | null;
  debounceMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

const closed: ComposerState = { open: false, trigger: null, view: EMPTY_VIEW, loading: false, note: null, skills: [], message: null };

export class ComposerModel {
  private state: ComposerState = closed;
  private readonly subs = new Set<() => void>();
  private draft = "";
  private suppressed: string | null = null;
  private dismissedFor: string | null = null;
  private seq = 0;
  private ac: AbortController | null = null;
  private timer: unknown = null;
  private rescan: unknown = null;
  private disposed = false;
  private offCatalog: (() => void) | null = null;

  constructor(private readonly d: ModelDeps) {
    this.offCatalog = d.catalog.subscribe(() => { if (this.state.trigger?.kind === "command") this.recompute(true); });
  }

  subscribe = (fn: () => void): (() => void) => { this.subs.add(fn); return () => { this.subs.delete(fn); }; };
  getState = (): ComposerState => this.state;
  private set(p: Partial<ComposerState>): void { this.state = { ...this.state, ...p }; for (const f of [...this.subs]) f(); }

  // --- draft changes -------------------------------------------------------------------------

  /** Call on every draft change. */
  update(draft: string): void {
    if (this.disposed) return;
    this.draft = draft;
    if (this.suppressed !== null) {
      const s = this.suppressed;
      this.suppressed = null;
      if (draft === s) { this.closeMenu(); return; }
    }
    const t = detectTrigger(draft);
    if (this.dismissedFor !== null) {
      if (draft === this.dismissedFor) return;
      this.dismissedFor = null;
    }
    if (!t) { this.closeMenu(); return; }
    const entering = this.state.trigger?.kind !== t.kind;
    this.state = { ...this.state, trigger: t };
    if (t.kind === "command") {
      this.cancelMention();
      if (entering) void this.d.catalog.ensure(); // refresh on OPEN only; a landed refresh re-ranks via the subscription
      this.recompute(false);
    } else {
      this.scheduleMention(t.query);
    }
  }

  private commandView(query: string): MenuView {
    const snap: CatalogSnapshot = this.d.catalog.snapshot();
    return buildCommandView({ catalog: snap, modes: buildModeItems(this.d.sources.modes()), models: buildModelItems(this.d.sources.models()) }, query);
  }

  /** Re-ranks the command menu; `keepRow` anchors the selection to the same row id across a data refresh. */
  private recompute(keepRow: boolean): void {
    const t = this.state.trigger;
    if (!t || t.kind !== "command") return;
    const view = this.commandView(t.query);
    let selected = view.selected;
    if (keepRow && this.state.open && this.state.view.items[this.state.view.selected]) {
      const id = this.state.view.items[this.state.view.selected].id;
      const at = view.items.findIndex((x) => x.id === id);
      if (at >= 0) selected = at;
    }
    if (view.items.length === 0) { this.closeMenu(); return; }
    this.set({ open: true, view: { ...view, selected }, loading: false, note: null, trigger: t });
  }

  // --- mentions (async, debounced, cancellable) ------------------------------------------------

  private cancelMention(): void {
    this.seq++;
    this.ac?.abort(); this.ac = null;
    if (this.timer !== null) { (this.d.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)))(this.timer); this.timer = null; }
    if (this.rescan !== null) { (this.d.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)))(this.rescan); this.rescan = null; }
  }

  private scheduleMention(query: string): void {
    const src = this.d.mentions;
    if (!src) { this.closeMenu(); return; }
    this.cancelMention();
    const mySeq = this.seq;
    const setT = this.d.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.set({ loading: true });
    this.timer = setT(() => {
      this.timer = null;
      void this.runMention(query, mySeq, 0);
    }, this.d.debounceMs ?? 60);
  }

  private async runMention(query: string, mySeq: number, attempt: number): Promise<void> {
    const src = this.d.mentions;
    if (!src || mySeq !== this.seq) return;
    const ac = new AbortController();
    this.ac = ac;
    let res: MentionResult;
    try { res = await src.search(query, ac.signal); } catch { res = { items: [], scan: "idle", note: null }; }
    if (mySeq !== this.seq || ac.signal.aborted || this.disposed) return;
    const view = buildMentionView(res.items);
    if (view.items.length === 0 && !res.note) { this.closeMenu(); return; }
    this.set({ open: true, view, loading: false, note: res.note, trigger: this.state.trigger });
    if (res.scan === "scanning" && attempt < 20) {
      // The index is still filling: look again shortly so late files appear without another keystroke.
      const setT = this.d.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
      this.rescan = setT(() => { this.rescan = null; void this.runMention(query, mySeq, attempt + 1); }, 400);
    }
  }

  // --- navigation + accept -----------------------------------------------------------------------

  private closeMenu(): void {
    this.cancelMention();
    if (this.state.open || this.state.trigger || this.state.loading) this.set({ open: false, trigger: null, view: EMPTY_VIEW, loading: false, note: null });
  }

  /** Escape: hide the menu until the draft changes. */
  dismiss(): void { this.dismissedFor = this.draft; this.closeMenu(); }

  moveUp(): void { this.move(-1); }
  moveDown(): void { this.move(1); }
  private move(delta: number): void {
    const n = this.state.view.items.length;
    if (!this.state.open || n === 0) return;
    this.set({ view: { ...this.state.view, selected: (this.state.view.selected + delta + n) % n } });
  }
  select(index: number): void {
    if (this.state.open && index >= 0 && index < this.state.view.items.length && index !== this.state.view.selected) this.set({ view: { ...this.state.view, selected: index } });
  }

  /** Accepts the selected row. Returns true when the key was handled. */
  accept(index?: number): boolean {
    if (!this.state.open) return false;
    const it = this.state.view.items[index ?? this.state.view.selected];
    if (!it) return false;
    const t = this.state.trigger;
    const a = acceptOf(it, this.draft, t?.kind === "mention" ? t.tokenStart : undefined);
    if (!a) return false;
    this.apply(a, it);
    return true;
  }

  private apply(a: Accept, it: MenuItem): void {
    const act = this.d.actions;
    switch (a.type) {
      case "replaceDraft":
        if (!a.keepOpen && !a.text.endsWith(" ")) this.suppressed = a.text;
        this.draft = a.text;
        act.setDraft(a.text);
        if (a.keepOpen) this.update(a.text); else this.closeMenu();
        return;
      case "useSkill": this.addChip({ id: a.id, name: a.name, kind: "library" }); this.finishToken(a.newDraft); return;
      case "useDirective": this.addChip({ id: it.id, name: a.name, kind: "directive", directive: a.directive }); this.finishToken(a.newDraft); return;
      case "navigate": act.navigate(a.target); this.finishToken(a.newDraft); return;
      case "setMode": act.setMode(a.mode); this.finishToken(a.newDraft); return;
      case "setModel": act.setModel(a.provider, a.model); this.finishToken(a.newDraft); return;
      case "attachFile": {
        const safe = safeMentionPath(a.path);
        if (safe && this.d.attachments) void this.d.attachments.addProjectFile(safe);
        else this.set({ message: "That file cannot be attached." });
        this.finishToken(a.newDraft);
        return;
      }
      case "attachNote": this.d.attachments?.addNote(a.label, a.content); this.finishToken(a.newDraft); return;
    }
  }

  private finishToken(newDraft: string): void {
    this.draft = newDraft;
    this.d.actions.setDraft(newDraft);
    this.closeMenu();
  }

  private addChip(c: SkillChip): void {
    if (this.state.skills.some((x) => x.id === c.id)) return;
    if (this.state.skills.length >= MAX_SKILL_CHIPS) { this.set({ message: `At most ${MAX_SKILL_CHIPS} skills per message.` }); return; }
    this.set({ skills: [...this.state.skills, c], message: null });
  }

  removeSkill(id: string): void { this.set({ skills: this.state.skills.filter((x) => x.id !== id) }); }
  clearMessage(): void { if (this.state.message) this.set({ message: null }); }

  // --- send ----------------------------------------------------------------------------------------

  /** A built-in typed as the whole message (never sent to the model), or null. */
  builtinOf(text: string): BuiltinCall | null { return parseBuiltin(text); }

  /** True while an attachment is still being read (the composer holds the send). */
  get blocked(): boolean { return this.d.attachments?.isBusy() ?? false; }

  /** Folds chips and attachments into the outgoing turn and clears them (one message only, like the Mac). */
  consumeForSend(text: string): SendPayload {
    const directives = this.state.skills.filter((c) => c.kind === "directive" && c.directive).map((c) => c.directive as string);
    const ids = this.state.skills.filter((c) => c.kind === "library").map((c) => c.id);
    const attachments = this.d.attachments?.consume() ?? [];
    if (this.state.skills.length) this.set({ skills: [] });
    return {
      text: directives.length ? `${directives.join("\n")}\n\n${text}` : text,
      skills: ids.length ? ids : undefined,
      attachments: attachments.length ? attachments : undefined,
    };
  }

  /** Chat switch or unmount: cancel reads, drop chips, stop timers. */
  dispose(): void {
    this.disposed = true;
    this.cancelMention();
    this.offCatalog?.();
    this.d.attachments?.dispose();
    this.subs.clear();
  }
}

export function createComposerModel(deps: Omit<ModelDeps, "catalog"> & { catalog: CatalogLoader }): ComposerModel {
  return new ComposerModel(deps);
}
export { createCatalogLoader };
