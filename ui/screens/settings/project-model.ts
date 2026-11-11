// Pure parts of the project "Paths" and "Memory" groups (read-only host listings of the active project).
import type { ProjectFolder, ProjectMemory, ProjectMemoryFile, ProjectPaths } from "./host.ts";

const clean = (v: unknown, max: number): string => {
  if (typeof v !== "string") return "";
  const s = v.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** A project-relative path we will show and hand to `reveal_in_os`: no absolute paths, no `..`, no NUL. */
export function safeRelativePath(v: unknown): string | null {
  if (typeof v !== "string" || v.length === 0 || v.length > 4096) return null;
  if (v.startsWith("/") || /^[A-Za-z]:[\\/]/.test(v)) return null;
  if (v.split(/[\\/]+/).some((seg) => seg === "..")) return null;
  if (/[\u0000-\u001f\u007f]/.test(v)) return null;
  return v;
}

export function decodePaths(v: unknown): ProjectPaths | null {
  if (!isRecord(v) || typeof v.root !== "string" || typeof v.id !== "string" || !Array.isArray(v.folders)) return null;
  const folders: ProjectFolder[] = [];
  for (const row of v.folders) {
    if (!isRecord(row)) continue;
    const name = safeRelativePath(row.name);
    if (!name || typeof row.exists !== "boolean") continue;
    folders.push({ name, exists: row.exists });
    if (folders.length >= 50) break;
  }
  return { root: clean(v.root, 4096), id: clean(v.id, 200), folders };
}

export function decodeMemory(v: unknown): ProjectMemory | null {
  if (!isRecord(v) || typeof v.root !== "string") return null;
  let graph: ProjectMemory["graph"] = null;
  if (isRecord(v.graph)) {
    const path = safeRelativePath(v.graph.path);
    const size = v.graph.sizeBytes;
    if (path && typeof size === "number" && Number.isFinite(size) && size >= 0) graph = { path, sizeBytes: size };
  }
  const files: ProjectMemoryFile[] = [];
  if (Array.isArray(v.files)) {
    for (const row of v.files) {
      if (!isRecord(row)) continue;
      const name = clean(row.name, 200);
      const path = safeRelativePath(row.path);
      const size = row.sizeBytes;
      if (!name || !path || typeof size !== "number" || !Number.isFinite(size) || size < 0) continue;
      files.push({ name, path, sizeBytes: size });
      if (files.length >= 200) break;
    }
  }
  return { root: clean(v.root, 4096), graph, files };
}

/** 0 B, 812 B, 12 KB, 3.4 MB — the same scale Settings uses elsewhere. */
export function bytesLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A loopback backend URL -> its port, or a sentence explaining what is wrong. */
export function parseBackendUrl(raw: string): { port: number } | { error: string } {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return { error: "Use an http(s) loopback URL." };
    if (u.hostname !== "127.0.0.1" && u.hostname !== "localhost") return { error: "Only localhost / 127.0.0.1 is allowed." };
    if (!u.port) return { error: "Include the port, for example http://127.0.0.1:3457." };
    const port = Number(u.port);
    return Number.isInteger(port) && port >= 1024 && port <= 65535 ? { port } : { error: "The port must be 1024-65535." };
  } catch {
    return { error: "That is not a valid server URL." };
  }
}

/** The cloud-sync provider a notes folder lives in, when it is one of the Mac's four known providers. */
export function syncProviderFor(path: string): string | null {
  if (path.includes("/Library/Mobile Documents/com~apple~CloudDocs/")) return "Synced via iCloud Drive";
  if (path.includes("/Dropbox/") || path.includes("/Library/CloudStorage/Dropbox")) return "Synced via Dropbox";
  if (path.includes("/Library/CloudStorage/GoogleDrive-")) return "Synced via Google Drive";
  if (path.includes("/Library/CloudStorage/OneDrive-")) return "Synced via OneDrive";
  return null;
}

/** The Mac Paths panel's one-line explanation per canonical folder. */
export function folderNote(name: string): string | null {
  switch (name) {
    case "source": return "Meeting & email transcripts";
    case "source/meetings": return "Meeting transcripts";
    case "source/emails": return "Ingested email";
    case "source/documents": return "Ingested documents";
    case "code": return "Code files";
    case "data": return "Documents, data, images";
    case "llm-doc": return "Generated LLM docs";
    case "llm-doc/plans": return "KB plans as Markdown (auto-generated)";
    case "llm-doc/generated": return "Generated documents";
    case "templates": return "Doc Gen templates";
    case "commands": return "Doc Gen commands";
    case "system": return "Settings, faults, graph, index (managed)";
    default: return null;
  }
}

export const PATHS_TEXT = {
  hint: "The folders the project uses on disk. The layout is read-only: it is fixed by the project. Changing it from Settings is not supported. Missing folders can be re-created here.",
  missing: "Missing",
  present: "Present",
  reveal: "Show in Finder",
  partial:
    "The layout is read-only here. This group shows the folders, opens them in Finder, re-creates missing folders, and links to Library for the index rebuild.",
  noProject: "Open a project to see its folders.",
} as const;

export const MEMORY_TEXT = {
  hint: "The project's system folder: the knowledge graph (when generated) and the agent memory files. Read-only.",
  graph: "Knowledge graph",
  generated: "Generated",
  notGenerated: "Not generated",
  files: "Memory files",
  empty: "No memory files yet. They appear after graph generation or an agent run.",
  reveal: "Show in Finder",
  noProject: "Open a project to see its memory files.",
} as const;

export function projectError(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  const text = typeof e === "string" ? e : e instanceof Error ? e.message : "";
  if (/no project is open/i.test(text) || code === "no_project") return PATHS_TEXT.noProject;
  return text ? text.slice(0, 200) : "The project folders could not be read.";
}
