// The desktop OsHost for graph-kit's System page. The page has no transport of its own; this adapter answers its
// calls through the shell's authenticated core client and the host's project files, the same contract the Mac app
// implements natively (see graph-kit/web/src/host.ts).
import type {
  OsCancel,
  OsFileContent,
  OsHost,
  OsOpenTarget,
  OsRange,
  OsSkill,
  OsSnapshot,
} from "@dnsmalla/graph-kit-web";
import type { SectionId } from "@llmide/screens/shell";

/** The page treats an error named OsAuthError as a refused session (its own class is not importable in node tests). */
export class SystemAuthError extends Error {
  constructor(message = "The session was refused.") {
    super(message);
    this.name = "OsAuthError";
  }
}

export interface SystemReply {
  status: number;
  body: unknown;
}

export type SystemRequest = (method: "GET" | "POST" | "PUT", path: string, body?: unknown) => Promise<SystemReply>;
export type SystemWatchStatus = Parameters<Parameters<OsHost["watch"]>[1]>[0];

export interface SystemHostDeps {
  request: SystemRequest;
  /** Starts the change feed; returns the stop function. The host reports connecting/live/reconnecting/stopped. */
  watch: (onChange: () => void, onStatus: (status: SystemWatchStatus, detail?: string) => void) => () => void;
  /** Navigates the shell; false only when there is nowhere to go (the page then says so). */
  openSection: (target: OsOpenTarget) => boolean;
  openFile: (path: string, line?: number) => boolean;
  /** The project graph in graph-kit's CGData shape, or null when there is none. */
  projectGraph: () => Promise<unknown | null>;
  /** One project file for the code preview. */
  loadFile: (path: string) => Promise<OsFileContent | null>;
}

/** The Mac's page targets mapped to the desktop shell's sections. `codeGraph` switches the Graph page instead. */
export function sectionForTarget(target: OsOpenTarget): SectionId | null {
  switch (target) {
    case "loop": return "loop";
    case "autoTasks": return "autotasks";
    case "settings": return "settings";
    case "library": return "library";
    case "explorer": return "explorer";
    case "codeGraph": return "graph";
    default: return null;
  }
}

function ensure(reply: SystemReply, what: string): unknown {
  if (reply.status === 401 || reply.status === 403) throw new SystemAuthError();
  if (reply.status < 200 || reply.status >= 300) throw new Error(`${what} failed (${reply.status})`);
  return reply.body;
}

/** Maps the server's skill library to the page's small skill type; malformed rows are dropped. */
export function toSystemSkills(body: unknown): OsSkill[] {
  const list = body && typeof body === "object" ? (body as { skills?: unknown }).skills : undefined;
  if (!Array.isArray(list)) return [];
  const out: OsSkill[] = [];
  for (const row of list) {
    if (!row || typeof row !== "object") continue;
    const e = row as Record<string, unknown>;
    if (typeof e.id !== "string" || typeof e.name !== "string") continue;
    const skill: OsSkill = { id: e.id, name: e.name };
    if (typeof e.description === "string") skill.description = e.description;
    if (typeof e.sourceName === "string") skill.source = e.sourceName;
    out.push(skill);
  }
  return out;
}

export function createSystemHost(deps: SystemHostDeps): OsHost {
  const host: OsHost = {
    async loadState(range: OsRange): Promise<OsSnapshot> {
      const reply = await deps.request("GET", `/kb/os/state?window=${range === "week" ? "week" : "day"}`);
      const body = ensure(reply, "GET /kb/os/state");
      if (!body || typeof body !== "object") throw new Error("The System state could not be read.");
      return body as OsSnapshot;
    },
    async cancel(request: NonNullable<OsCancel>): Promise<void> {
      if (request.method !== "POST" || typeof request.path !== "string" || !request.path.startsWith("/")) {
        throw new Error("Unsupported cancel request.");
      }
      ensure(await deps.request("POST", request.path, request.body), "cancel");
    },
    watch(onChange, onStatus) {
      return deps.watch(onChange, onStatus);
    },
    open(target: OsOpenTarget): boolean {
      return deps.openSection(target);
    },
    openFile(path: string, line?: number): boolean {
      return deps.openFile(path, line);
    },
    async loadFile(path: string): Promise<OsFileContent | null> {
      return deps.loadFile(path);
    },
    async loadSkills(): Promise<OsSkill[]> {
      return toSystemSkills(ensure(await deps.request("GET", "/kb/agent/skill-library"), "skills"));
    },
    async loadProjectGraph(): Promise<unknown | null> {
      return deps.projectGraph();
    },
  };
  return host;
}
