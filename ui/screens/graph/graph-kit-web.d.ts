// Type surface for graph-kit's System page, consumed from the submodule source through the desktop Vite alias.
// The submodule is compiled with its own tsconfig (which allows the unused locals that the desktop's strict
// noUnusedLocals rejects), so the desktop declares the contract it uses instead of type-checking the submodule.
declare module "@dnsmalla/graph-kit-web" {
  export class OsAuthError extends Error {}
  export type OsRange = "day" | "week";
  export type OsOpenTarget = "loop" | "autoTasks" | "settings" | "library" | "explorer" | "codeGraph";
  export type OsLiveStatus = "connecting" | "live" | "reconnecting" | "stopped";
  export type OsSnapshot = Record<string, unknown>;
  export interface OsCancel {
    method: string;
    path: string;
    body?: Record<string, unknown>;
  }
  export interface OsFileContent {
    path: string;
    text?: string;
    truncated?: boolean;
    bytes?: number;
    language?: string | null;
    binary?: boolean;
  }
  export interface OsSkill {
    id: string;
    name: string;
    description?: string;
    source?: string;
  }
  export interface OsRoutine {
    id: string;
    name: string;
    [key: string]: unknown;
  }
  export interface OsHost {
    loadState(range: OsRange): Promise<OsSnapshot>;
    cancel(request: NonNullable<OsCancel>): Promise<void>;
    watch(onChange: () => void, onStatus: (status: OsLiveStatus, detail?: string) => void): () => void;
    open(target: OsOpenTarget): boolean;
    openFile?(path: string, line?: number): boolean;
    copyText?(text: string): boolean;
    loadProjectGraph?(): Promise<unknown | null>;
    loadFile?(path: string): Promise<OsFileContent | null>;
    loadSkills?(): Promise<OsSkill[]>;
    loadRoutines?(): Promise<OsRoutine[]>;
  }
  export interface MountOptions {
    theme?: string;
    projectName?: string | null;
    doc?: Document;
  }
  export interface OsViewHandle {
    configure(cfg: { theme?: string; projectName?: string | null }): void;
    notifyChange(): void;
    retry(): void;
    dispose(): void;
  }
  export function mountOsView(root: HTMLElement, host: OsHost, opts?: MountOptions): OsViewHandle;
}
