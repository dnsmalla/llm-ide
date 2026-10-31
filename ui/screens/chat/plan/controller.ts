// PlanController: saving a plan reply under `llm-doc/plans/` of the open project through the host's root-confined
// fs, and the per-message state the card shows (saving / saved / error / executing). Guards copied from the Mac:
// one save at a time per message, an already saved plan is not written twice, a revision goes INTO the chat's
// existing plan file.
import type { ProjectFs } from "../mentions/project-fs";
import { PLANS_DIR, planFilePath } from "./detect";

export type PlanSaveState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "saved"; path: string }
  | { status: "error"; message: string };

export interface PlanActionState {
  save: PlanSaveState;
  executed: boolean;
  /** The user's edited title and text (Execute and later saves use them instead of the reply). */
  edited: { title: string; content: string } | null;
}

const IDLE: PlanActionState = { save: { status: "idle" }, executed: false, edited: null };

export class PlanController {
  private readonly states = new Map<string, PlanActionState>();
  /** Last plan file written per chat (a later save of that chat goes into it). */
  private readonly lastPath = new Map<string, string>();
  private readonly subs = new Set<() => void>();
  private version = 0;

  constructor(private readonly fs: ProjectFs | null, private readonly now: () => Date = () => new Date()) {}

  subscribe = (fn: () => void): (() => void) => { this.subs.add(fn); return () => { this.subs.delete(fn); }; };
  getVersion = (): number => this.version;
  get canSave(): boolean { return this.fs !== null; }
  private emit(): void { this.version++; for (const f of [...this.subs]) f(); }
  private key = (chatId: string, messageId: string): string => `${chatId}\u0000${messageId}`;

  get(chatId: string, messageId: string): PlanActionState { return this.states.get(this.key(chatId, messageId)) ?? IDLE; }
  private set(chatId: string, messageId: string, p: Partial<PlanActionState>): void {
    this.states.set(this.key(chatId, messageId), { ...this.get(chatId, messageId), ...p });
    this.emit();
  }

  /** Saves the plan; resolves with the project-relative path, or null when refused or failed (the state says why). */
  async save(chatId: string, messageId: string, title: string, content: string, replace = false): Promise<string | null> {
    const cur = this.get(chatId, messageId).save;
    if (cur.status === "saving") return null;
    if (cur.status === "saved" && !replace) return cur.path; // already on disk: silent, not an error
    if (replace) this.set(chatId, messageId, { edited: { title, content } });
    if (!this.fs) { this.set(chatId, messageId, { save: { status: "error", message: "Open a project to save a plan." } }); return null; }
    if (content.trim() === "") { this.set(chatId, messageId, { save: { status: "error", message: "The plan has no content." } }); return null; }
    this.set(chatId, messageId, { save: { status: "saving" } });
    const path = cur.status === "saved" ? cur.path : planFilePath(title, this.now(), this.lastPath.get(chatId));
    try {
      await this.fs.ensureDir("llm-doc");
      await this.fs.ensureDir(PLANS_DIR);
      await this.fs.writeText(path, content.endsWith("\n") ? content : `${content}\n`);
      this.lastPath.set(chatId, path);
      this.set(chatId, messageId, { save: { status: "saved", path } });
      return path;
    } catch (e) {
      const code = e && typeof e === "object" && typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : "";
      const message = code === "no_project" ? "Open a project to save a plan." : code === "conflict" ? "The plan file changed on disk. Reload and save again." : "The plan could not be saved.";
      this.set(chatId, messageId, { save: { status: "error", message } });
      return null;
    }
  }

  markExecuted(chatId: string, messageId: string): void { this.set(chatId, messageId, { executed: true }); }
  savedPath(chatId: string, messageId: string): string | null { const s = this.get(chatId, messageId).save; return s.status === "saved" ? s.path : null; }
  forget(chatId: string): void {
    for (const k of [...this.states.keys()]) if (k.startsWith(`${chatId}\u0000`)) this.states.delete(k);
    this.lastPath.delete(chatId);
    this.emit();
  }
}
