// Remote mode's project list and picker, fetched from GET /projects and remembered per hub pin.
// No local folder is involved: the id is the canonical project id the hub's routes use.
import type { CoreClient } from "./core";

/** Remote mode must not ask for projects before the keychain session has restored a token. */
export const remoteProjectsReady = (signedIn: boolean): boolean => signedIn;

export type ProjectRole = "owner" | "admin" | "member" | "viewer";
export type RunMode = "none" | "read_only" | "execute";
export interface RemoteProject {
  id: string; name: string; role: ProjectRole; maxMode: RunMode; usdCapMonth: number; permissions: string[];
}
export interface KeyValueStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
export interface RemoteProjectsState {
  projects: RemoteProject[]; selectedId: string | null; status: "loading" | "ready" | "error"; error: string | null;
}
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const ROLES: readonly ProjectRole[] = ["owner", "admin", "member", "viewer"];
const MODES: readonly RunMode[] = ["none", "read_only", "execute"];

export function decodeProjects(raw: unknown): RemoteProject[] | null {
  if (!isRecord(raw) || !Array.isArray(raw.projects)) return null;
  const out: RemoteProject[] = [];
  for (const p of raw.projects) {
    if (!isRecord(p) || typeof p.id !== "string" || p.id.length === 0 || typeof p.name !== "string") return null;
    if (!ROLES.includes(p.role as ProjectRole) || !MODES.includes(p.maxMode as RunMode)) return null;
    if (typeof p.usdCapMonth !== "number" || !Array.isArray(p.permissions) || !p.permissions.every((x) => typeof x === "string")) return null;
    out.push({ id: p.id, name: p.name, role: p.role as ProjectRole, maxMode: p.maxMode as RunMode, usdCapMonth: p.usdCapMonth, permissions: p.permissions as string[] });
  }
  return out;
}

class Store<T> {
  #state: T;
  #listeners = new Set<() => void>();
  constructor(initial: T) { this.#state = initial; }
  getState = (): T => this.#state;
  subscribe = (l: () => void): (() => void) => { this.#listeners.add(l); return () => this.#listeners.delete(l); };
  protected set(patch: Partial<T>): void { this.#state = { ...this.#state, ...patch }; for (const l of [...this.#listeners]) l(); }
}

export class RemoteProjects extends Store<RemoteProjectsState> {
  readonly #client: Pick<CoreClient, "request">;
  readonly #storage: KeyValueStorage;
  readonly #key: string;
  #loading: Promise<void> | null = null;
  constructor(client: Pick<CoreClient, "request">, storage: KeyValueStorage, hubKey: string) {
    super({ projects: [], selectedId: null, status: "loading", error: null });
    this.#client = client; this.#storage = storage; this.#key = `llmide.remoteProject:${hubKey}`;
  }
  get selected(): RemoteProject | null { const s = this.getState(); return s.projects.find((p) => p.id === s.selectedId) ?? null; }
  whenReady(): Promise<void> { return this.#loading ?? this.refresh(); }
  refresh(): Promise<void> {
    this.#loading ??= (async () => {
      this.set({ status: "loading", error: null });
      try {
        const projects = decodeProjects(await this.#client.request("/projects"));
        if (!projects) throw new Error("bad projects answer");
        const stored = this.#storage.getItem(this.#key);
        const selectedId = projects.some((p) => p.id === stored) ? stored : projects[0]?.id ?? null;
        this.set({ projects, selectedId, status: "ready", error: null });
      } catch (e) { this.set({ status: "error", error: e instanceof Error ? e.message : "Could not load hub projects." }); }
      finally { this.#loading = null; }
    })();
    return this.#loading;
  }
  select(id: string): void {
    if (!this.getState().projects.some((p) => p.id === id)) return;
    this.set({ selectedId: id });
    try { this.#storage.setItem(this.#key, id); } catch { /* private window */ }
  }
}
