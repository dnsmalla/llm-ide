// The web app's project scope over Host API v1 `host`: `projects.list`, the caller's role on each project, the
// selected project (persisted per host in browser storage, never a secret), and the host's refusal reason.
// No React here. A frame without `projectId` keeps the v1 team behavior, so an empty list still chats.
import type { HostLink } from "../host-api/connection.ts";
import type { HostApiResult } from "../host-api/types.generated.ts";
import type { ProjectStore } from "../host-api/storage.ts";

export type Project = HostApiResult<"projects.list">["projects"][number];
export type ProjectRole = Project["role"];
export type ProjectRefusalCode = "PROJECT_REQUIRED" | "PROJECT_DENIED" | "PROJECT_MISMATCH";
export interface ProjectRefusal { code: ProjectRefusalCode; message: string }

export interface ProjectsState {
  projects: readonly Project[];
  selectedId: string | null;
  loading: boolean;
  loaded: boolean; // at least one projects.list reply has landed
  error: string | null; // projects.list itself failed
  refusal: ProjectRefusal | null; // a project-scoped frame was refused
}

export const initialProjectsState: ProjectsState = {
  projects: [], selectedId: null, loading: true, loaded: false, error: null, refusal: null,
};

const MAX_PROJECTS = 500; // projects.list maxItems
const messageOf = (e: unknown) => (e instanceof Error && e.message ? e.message.slice(0, 500) : "Something went wrong.");
const errorCode = (e: unknown): string | null =>
  e && typeof e === "object" && typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : null;

// The contract has no PROJECT_* error codes yet: the gateway answers `denied` (role/project refusal) or `not_found`
// (the named project is not registered here). Also accept a host that names a PROJECT_* code (in the error or its
// message), so this page is ready for the narrower contract without pretending the old one already sends it.
const LITERAL = /\bPROJECT_(REQUIRED|DENIED|MISMATCH)\b/;
const PROJECT_CODES = new Set<ProjectRefusalCode>(["PROJECT_REQUIRED", "PROJECT_DENIED", "PROJECT_MISMATCH"]);

export function projectRefusal(e: unknown, selectedId: string | null): ProjectRefusal | null {
  const message = e instanceof Error && e.message ? e.message.slice(0, 500) : null;
  const raw = errorCode(e);
  if (raw && PROJECT_CODES.has(raw as ProjectRefusalCode)) return { code: raw as ProjectRefusalCode, message: message ?? raw };
  const literal = message ? LITERAL.exec(message) : null;
  if (literal) return { code: `PROJECT_${literal[1]}` as ProjectRefusalCode, message: message ?? literal[0] };
  if (!selectedId) return null; // a team-role refusal is not a project refusal
  if (raw === "denied") return { code: "PROJECT_DENIED", message: message ?? "The desktop refused this project." };
  if (raw === "not_found") return { code: "PROJECT_MISMATCH", message: message ?? "That project is not registered on this computer." };
  return null;
}

function readProjects(r: HostApiResult<"projects.list">): Project[] {
  // The host validates its own frames; this only keeps a surprising reply from breaking the picker.
  const list = Array.isArray(r?.projects) ? r.projects : [];
  return list.slice(0, MAX_PROJECTS).map((p) => ({
    id: p.id, name: p.name.slice(0, 120), role: p.role, maxMode: p.maxMode,
    usdCapMonth: p.usdCapMonth, permissions: Array.isArray(p.permissions) ? p.permissions.slice(0, 32) : [],
  }));
}

export interface ProjectsControllerOptions {
  storage: ProjectStore;
  /** Fires only when the selected id changes (including the first selection from projects.list). */
  onSelectionChange?: (id: string | null) => void;
}

export function createProjectsController(link: HostLink, { storage, onSelectionChange }: ProjectsControllerOptions) {
  let state = initialProjectsState;
  let seq = 0;
  const subs = new Set<() => void>();
  const set = (p: Partial<ProjectsState>) => { state = { ...state, ...p }; for (const fn of subs) fn(); };
  const select = (id: string | null) => {
    if (id === state.selectedId) return;
    set({ selectedId: id, refusal: null });
    storage.set(id);
    onSelectionChange?.(id);
  };

  const load = async () => {
    const mine = ++seq;
    set({ loading: true, error: null });
    try {
      const projects = readProjects(await link.send("projects.list", {}).done);
      if (mine !== seq) return;
      // The stored choice wins while it still exists; otherwise the first project, else none.
      const stored = storage.get();
      const keep = projects.some((p) => p.id === state.selectedId) ? state.selectedId : null;
      const next = keep ?? projects.find((p) => p.id === stored)?.id ?? projects[0]?.id ?? null;
      const changed = next !== state.selectedId;
      set({ projects, loading: false, loaded: true, error: null, selectedId: next, refusal: changed ? null : state.refusal });
      storage.set(next);
      if (changed) onSelectionChange?.(next);
    } catch (e) {
      if (mine !== seq) return;
      // A failed list must not throw the picker away; keep the previous projects and choice.
      set({ loading: false, loaded: true, error: messageOf(e) });
    }
  };

  const off = link.onResync(() => { void load(); });
  return {
    getState: () => state,
    getSelectedId: () => state.selectedId,
    subscribe: (fn: () => void) => { subs.add(fn); return () => { subs.delete(fn); }; },
    load,
    select(id: string): boolean {
      const hit = state.projects.find((p) => p.id === id);
      if (!hit) return false;
      select(id);
      return true;
    },
    /** Show a project-scoped frame's refusal without disabling the picker; a non-project error is ignored. */
    noteRefusal(e: unknown): ProjectRefusal | null {
      const refusal = projectRefusal(e, state.selectedId);
      if (refusal) set({ refusal });
      return refusal;
    },
    clearRefusal() { if (state.refusal) set({ refusal: null }); },
    dispose() { seq += 1; off(); subs.clear(); },
  };
}

export type ProjectsController = ReturnType<typeof createProjectsController>;
