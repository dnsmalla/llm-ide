// Settings -> Agent history. A port of the Mac AgentHistoryModel: the Clear flow is a
// small state machine (preview = dry run, confirm = real clear with the preview's signed
// id) and a stale preview is counted again, never deleted on.
import { call, type CoreClient } from "./core-api.ts";
import {
  decodeAgentHistorySettings,
  decodeClearResult,
  decodeCompactResult,
  decodeStorageReport,
  type AgentHistorySettings,
  type ClearResult,
  type ClearScope,
  type CompactResult,
  type StorageReport,
} from "./decoders.ts";
import { ApiError } from "./core-api.ts";
import { describeError, messageForCode, STALE_PREVIEW_CODES } from "./errors.ts";
import { Store } from "./store.ts";

export type ClearAge = "all" | "older7" | "older30" | "older90";
export const CLEAR_AGES: readonly { id: ClearAge; label: string; beforeDays: number | null }[] = [
  { id: "all", label: "All", beforeDays: null },
  { id: "older7", label: "Older than 7 days", beforeDays: 7 },
  { id: "older30", label: "Older than 30 days", beforeDays: 30 },
  { id: "older90", label: "Older than 90 days", beforeDays: 90 },
];
const beforeDaysOf = (a: ClearAge): number | null => CLEAR_AGES.find((x) => x.id === a)?.beforeDays ?? null;

export function rowLabel(key: string): string {
  switch (key) {
    case "agent_runs": return "Runs";
    case "agent_tool_events": return "Tool events";
    case "turn_composition": return "Turn composition";
    case "agent_daily": return "Daily rollups";
    case "agent_daily_tools": return "Daily tool rollups";
    default: return key;
  }
}

export function scopeSentence(scope: ClearScope, age: ClearAge): string {
  const what = scope === "raw" ? "raw history (runs and tool events); the daily summaries are kept" : "all agent history, including the daily summaries";
  const when = age === "all" ? "" : ` older than ${beforeDaysOf(age)} days`;
  return `This deletes ${what}${when}. It cannot be undone.`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

export function compactSuccess(r: CompactResult): string {
  return `Compacted (${r.mode}): freed ${r.pagesFreed} pages, ${formatBytes(r.bytesBefore)} to ${formatBytes(r.bytesAfter)}.`;
}

export function clearSuccess(r: ClearResult): string {
  return r.total === 0 ? "Nothing to delete. The history was already empty." : `Deleted ${r.total} rows.`;
}

export type ClearPhase =
  | { kind: "idle" }
  | { kind: "previewing"; scope: ClearScope }
  | { kind: "confirming"; scope: ClearScope; preview: ClearResult }
  | { kind: "clearing"; scope: ClearScope }
  | { kind: "cleared"; result: ClearResult }
  | { kind: "failed"; message: string };

export interface AgentHistoryState {
  report: StorageReport | null;
  settings: AgentHistorySettings | null;
  loadError: string | null;
  retentionDraft: number;
  savingRetention: boolean;
  retentionMessage: string | null;
  clear: ClearPhase;
  clearAge: ClearAge;
  clearNotice: string | null;
  compacting: boolean;
  compactMessage: { text: string; isError: boolean } | null;
}

export class AgentHistoryModel extends Store<AgentHistoryState> {
  readonly #c: CoreClient;
  #gen = 0;
  #loadGen = 0;
  #abort: AbortController | null = null;

  constructor(client: CoreClient) {
    super({
      report: null, settings: null, loadError: null, retentionDraft: 30, savingRetention: false, retentionMessage: null,
      clear: { kind: "idle" }, clearAge: "all", clearNotice: null, compacting: false, compactMessage: null,
    });
    this.#c = client;
  }

  get retentionRange(): { min: number; max: number } {
    const s = this.getState().settings;
    return s ? { min: s.min, max: s.max } : { min: 7, max: 365 };
  }
  get retentionChanged(): boolean {
    const s = this.getState();
    return s.settings !== null && s.settings.retentionDays !== s.retentionDraft;
  }
  get canDismissClear(): boolean {
    return this.getState().clear.kind !== "clearing";
  }

  setRetentionDraft(days: number): void {
    this.set({ retentionDraft: days, retentionMessage: null });
  }

  async load(): Promise<void> {
    const gen = ++this.#loadGen;
    try {
      const [report, settings] = await Promise.all([this.#report(), this.#settings()]);
      if (gen !== this.#loadGen) return;
      this.set({ report, settings, retentionDraft: settings.retentionDays, loadError: null });
    } catch (e) {
      if (gen !== this.#loadGen) return;
      this.set({ loadError: describeError(e) });
    }
  }

  dispose(): void {
    this.#loadGen++;
    this.#gen++;
    this.#abort?.abort();
  }

  #report = async (): Promise<StorageReport> => decodeStorageReport(await call(this.#c, "GET", "/kb/storage"));
  #settings = async (): Promise<AgentHistorySettings> => decodeAgentHistorySettings(await call(this.#c, "GET", "/kb/agent-history/settings"));

  async saveRetention(): Promise<void> {
    if (!this.retentionChanged) return;
    const requested = this.getState().retentionDraft;
    this.set({ savingRetention: true });
    try {
      const saved = decodeAgentHistorySettings(await call(this.#c, "PUT", "/kb/agent-history/settings", { retentionDays: requested }));
      this.set({
        settings: saved,
        retentionDraft: saved.retentionDays,
        retentionMessage:
          saved.retentionDays === requested
            ? `Saved. Raw history is kept for ${saved.retentionDays} days.`
            : `Saved as ${saved.retentionDays} days; the limit is ${saved.min} to ${saved.max}.`,
      });
      await this.#refreshReport();
    } catch (e) {
      this.set({ retentionMessage: describeError(e) });
    } finally {
      this.set({ savingRetention: false });
    }
  }

  /** Step one: a dry run. Opens the sheet with counts; deletes nothing. Ignored while a step runs. */
  async beginClear(scope: ClearScope, age: ClearAge = "all"): Promise<void> {
    if (this.getState().clear.kind !== "idle") return;
    this.set({ clearAge: age });
    await this.#preview(scope, ++this.#gen, null);
  }

  /** Another age picked in the open sheet: the old preview is dropped at once and counted again. */
  async setClearAge(age: ClearAge): Promise<void> {
    const s = this.getState();
    if (age === s.clearAge) return;
    if (s.clear.kind !== "confirming" && s.clear.kind !== "previewing") return;
    const scope = s.clear.scope;
    this.set({ clearAge: age, clear: { kind: "previewing", scope } });
    await this.#preview(scope, ++this.#gen, null);
  }

  /** Step two: the real clear with the preview's id. A stale preview is counted again instead. */
  async confirmClear(): Promise<void> {
    const c = this.getState().clear;
    if (c.kind !== "confirming" || !c.preview.previewId) return;
    const gen = ++this.#gen;
    const previewId = c.preview.previewId;
    this.set({ clear: { kind: "clearing", scope: c.scope } });
    try {
      const result = decodeClearResult(
        await call(this.#c, "POST", "/kb/agent-history/clear", {
          scope: c.scope, beforeDays: beforeDaysOf(this.getState().clearAge), dryRun: false, previewId,
        }),
      );
      if (gen !== this.#gen) return;
      this.set({ clear: { kind: "cleared", result } });
      await this.#refreshReport();
    } catch (e) {
      if (gen !== this.#gen) return;
      if (e instanceof ApiError && STALE_PREVIEW_CODES.has(e.code)) {
        await this.#preview(c.scope, gen, messageForCode(e.code, e.status));
      } else {
        this.set({ clear: { kind: "failed", message: describeError(e) } });
      }
    }
  }

  /** Dismisses the sheet. Refused while the real delete runs. */
  cancelClear(): void {
    if (!this.canDismissClear) return;
    this.#gen++;
    this.set({ clear: { kind: "idle" }, clearNotice: null });
  }

  async compact(): Promise<void> {
    this.set({ compacting: true, compactMessage: null });
    try {
      const r = decodeCompactResult(await call(this.#c, "POST", "/kb/agent-history/compact", {}));
      this.set({ compactMessage: { text: compactSuccess(r), isError: false } });
      await this.#refreshReport();
    } catch (e) {
      this.set({ compactMessage: { text: describeError(e), isError: true } });
    } finally {
      this.set({ compacting: false });
    }
  }

  async #preview(scope: ClearScope, gen: number, notice: string | null): Promise<void> {
    this.set({ clear: { kind: "previewing", scope }, clearNotice: null });
    try {
      const preview = decodeClearResult(
        await call(this.#c, "POST", "/kb/agent-history/clear", { scope, beforeDays: beforeDaysOf(this.getState().clearAge), dryRun: true }),
      );
      if (gen !== this.#gen) return;
      if (!preview.previewId) {
        this.set({ clear: { kind: "failed", message: "The server did not return a preview. Nothing was deleted." } });
        return;
      }
      this.set({ clearNotice: notice, clear: { kind: "confirming", scope, preview } });
    } catch (e) {
      if (gen !== this.#gen) return;
      this.set({ clear: { kind: "failed", message: describeError(e) } });
    }
  }

  async #refreshReport(): Promise<void> {
    try {
      this.set({ report: await this.#report() });
    } catch {
      // keep the previous numbers
    }
  }
}

/** The word the user types to enable the real delete (explicit confirm for a destructive action). */
export const CLEAR_CONFIRM_WORD = "DELETE";
export const clearConfirmed = (typed: string): boolean => typed.trim() === CLEAR_CONFIRM_WORD;
