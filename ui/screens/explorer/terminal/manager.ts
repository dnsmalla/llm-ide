// Terminal dock state: tabs, consent / feature state, spawn and kill. React-free; the host (`pty_*`) and the
// xterm runtime are injected, so the session logic is tested with a fake.
//
// Rules: nothing spawns until `spawn` is called from a user action (the native consent dialog appears on the
// first spawn); a refusal is shown as a denied state with "Try again"; the shell's working directory is the
// active project root (set by the host); closing a tab kills its shell; a project change kills them all.
import type { PtyHandle } from "../../../../desktop/src/terminal/ptyClient";

export type { PtyHandle };

export interface PtyStatus {
  enabled: boolean;
  consent: "unasked" | "granted" | "denied";
  shell: string;
}

export interface TermHost {
  status(): Promise<PtyStatus>;
  retryConsent(): Promise<PtyStatus>;
  spawn(cols: number, rows: number, onBytes: (b: Uint8Array) => void): Promise<PtyHandle>;
}

export type TabState = "starting" | "running" | "exited" | "error";

export interface TermTab {
  id: number;
  title: string;
  state: TabState;
  error: string | null;
}

export type DockPhase = "loading" | "disabled" | "needs-consent" | "denied" | "ready" | "error";

export interface DockState {
  phase: DockPhase;
  status: PtyStatus | null;
  error: string | null;
  tabs: TermTab[];
  active: number | null;
  /** The last "Try again" was refused (rate limit / cap). */
  retryMessage: string | null;
}

export const MAX_TABS = 8;

export function classifySpawnError(message: string): "denied" | "disabled" | "limit" | "other" {
  const m = message.toLowerCase();
  if (m.includes("not approved")) return "denied";
  if (m.includes("disabled")) return "disabled";
  if (m.includes("too many terminals")) return "limit";
  return "other";
}

function errText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return "terminal error";
}

export function phaseFor(s: PtyStatus): DockPhase {
  if (!s.enabled) return "disabled";
  if (s.consent === "granted") return "ready";
  if (s.consent === "denied") return "denied";
  return "needs-consent";
}

export class TerminalManager {
  private snap: DockState = { phase: "loading", status: null, error: null, tabs: [], active: null, retryMessage: null };
  private listeners = new Set<() => void>();
  private handles = new Map<number, PtyHandle>();
  private nextId = 1;
  private disposed = false;

  constructor(private readonly host: TermHost) {}

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = (): DockState => this.snap;

  private set(p: Partial<DockState>): void {
    this.snap = { ...this.snap, ...p };
    for (const l of [...this.listeners]) l();
  }

  private patchTab(id: number, p: Partial<TermTab>): void {
    this.set({ tabs: this.snap.tabs.map((t) => (t.id === id ? { ...t, ...p } : t)) });
  }

  /** Reads feature + consent state. Never prompts, never spawns. */
  async refresh(): Promise<void> {
    try {
      const status = await this.host.status();
      if (this.disposed) return;
      this.set({ status, phase: this.snap.tabs.length > 0 && status.consent === "granted" ? "ready" : phaseFor(status), error: null });
    } catch (e) {
      if (!this.disposed) this.set({ phase: "error", error: errText(e) });
    }
  }

  /** Adds a tab entry; the view mounts, fits, then calls `start`. A user action only. */
  openTab(): number | null {
    if (this.snap.tabs.length >= MAX_TABS || this.snap.phase === "disabled") return null;
    const id = this.nextId++;
    this.set({ tabs: [...this.snap.tabs, { id, title: `${this.snap.status?.shell ?? "shell"} ${id}`, state: "starting", error: null }], active: id });
    return id;
  }

  /** Spawns the shell for a tab once its view has a size. Resolves the handle, or null on failure. */
  async start(id: number, cols: number, rows: number, onBytes: (b: Uint8Array) => void): Promise<PtyHandle | null> {
    const tab = this.snap.tabs.find((t) => t.id === id);
    if (!tab || tab.state !== "starting") return null;
    try {
      const h = await this.host.spawn(cols, rows, onBytes);
      if (this.disposed || !this.snap.tabs.some((t) => t.id === id)) {
        await h.kill();
        return null;
      }
      this.handles.set(id, h);
      this.patchTab(id, { state: "running", title: `${h.shell} ${id}` });
      if (this.snap.phase !== "ready") this.set({ phase: "ready", status: this.snap.status ? { ...this.snap.status, consent: "granted" } : this.snap.status });
      return h;
    } catch (e) {
      if (this.disposed) return null;
      const msg = errText(e);
      const kind = classifySpawnError(msg);
      this.dropTab(id);
      if (kind === "denied") this.set({ phase: "denied", retryMessage: null });
      else if (kind === "disabled") this.set({ phase: "disabled" });
      else if (kind === "limit") this.set({ error: `Too many terminals (max ${MAX_TABS}). Close one first.` });
      else this.set({ phase: this.snap.tabs.length ? this.snap.phase : "error", error: `Cannot start the shell: ${msg}` });
      return null;
    }
  }

  /** The shell is gone (a write failed with "no such terminal"). */
  markExited(id: number): void {
    const t = this.snap.tabs.find((x) => x.id === id);
    if (!t || t.state === "exited") return;
    this.handles.delete(id);
    this.patchTab(id, { state: "exited" });
  }

  /** "Try again" after a refusal: re-arms the consent dialog (the host rate-limits it). */
  async retry(): Promise<void> {
    try {
      const status = await this.host.retryConsent();
      if (this.disposed) return;
      this.set({ status, phase: phaseFor(status), retryMessage: null });
    } catch (e) {
      if (!this.disposed) this.set({ retryMessage: errText(e) });
    }
  }

  activate(id: number): void {
    if (this.snap.tabs.some((t) => t.id === id)) this.set({ active: id });
  }

  private dropTab(id: number): void {
    const tabs = this.snap.tabs.filter((t) => t.id !== id);
    const idx = this.snap.tabs.findIndex((t) => t.id === id);
    const active = this.snap.active === id ? (tabs[Math.min(idx, tabs.length - 1)]?.id ?? null) : this.snap.active;
    this.set({ tabs, active });
  }

  /** Kill-on-close: the shell (and its foreground job) is terminated by the host. */
  async closeTab(id: number): Promise<void> {
    const h = this.handles.get(id);
    this.handles.delete(id);
    this.dropTab(id);
    if (h) await h.kill();
  }

  /** Project changed or the screen is going away: no shell may outlive its project. */
  async closeAll(): Promise<void> {
    const hs = [...this.handles.values()];
    this.handles.clear();
    this.set({ tabs: [], active: null });
    await Promise.all(hs.map((h) => h.kill()));
  }

  handle(id: number): PtyHandle | undefined {
    return this.handles.get(id);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.closeAll();
    this.listeners.clear();
  }
}
