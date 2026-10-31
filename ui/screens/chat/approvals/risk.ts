// Risk class of a parked tool approval, from the tool name and its arguments only. Pure; deliberately
// conservative: anything not recognised is "unknown" and is never batched or offered a saved rule here.
import type { PendingApproval } from "../state";
import { analyzeCommand } from "./command";
import { hasHidden } from "./sanitize";

export type RiskClass = "edit" | "create" | "overwrite" | "command" | "network" | "extension" | "unknown";

export interface Risk {
  risk: RiskClass;
  /** Short label for the card header badge. */
  label: string;
  /** ADVISORY: looks like it can destroy or exfiltrate data, or reach outside the project. Never use `false` to grant anything: batching and saved rules require a positive check (pathKnown / the rules.ts allowlist). */
  destructive: boolean;
  /** Plain reasons, shown on the card. */
  reasons: string[];
  /** The file the tool touches, when it names one. */
  path: string | null;
  /** The file is outside the open project root, or could not be checked (no root, `..`, `~`, hidden characters). */
  outsideProject: boolean;
  /** An edit/write names exactly one usable path that is textually inside the turn's root. Required for batching and session rules. */
  pathKnown: boolean;
  /** A command uses constructs that hide what really runs (see command.ts). */
  opaque: boolean;
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

const segments = (p: string): string[] => p.replace(/\\/g, "/").split("/");
const norm = (p: string): string => {
  const parts: string[] = [];
  for (const seg of segments(p)) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop(); else parts.push(seg);
  }
  return parts.join("/");
};
const isAbs = (p: string) => p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\");

/**
 * Why `path` cannot be treated as inside `root`, or null when it is. Containment is TEXTUAL: `~`, `..` anywhere, hidden
 * characters, variables and wildcards are refused outright rather than resolved, and a symlink inside the project that
 * points out of it cannot be seen here (the host resolves links when it applies the edit). Fails closed: with no known
 * root nothing is inside.
 */
export function pathProblem(path: string, root: string | null): string | null {
  if (hasHidden(path)) return "has a path with hidden characters";
  if (path.startsWith("~")) return "uses a path starting with ~";
  if (segments(path).includes("..")) return "uses a path containing ..";
  if (/[$%*?]/.test(path) || path.includes("\0")) return "uses a path with variables or wildcards";
  if (!root) return "cannot be checked: no project root is known for this turn";
  const r = norm(root);
  const joined = isAbs(path) ? norm(path) : norm(`${root}/${path}`);
  return joined === r || joined.startsWith(`${r}/`) ? null : "touches a path outside the open project";
}

/** True when `path` is inside `root` (see `pathProblem`). */
export function insideRoot(path: string, root: string | null): boolean {
  return pathProblem(path, root) === null;
}

const PATH_KEYS = ["filePath", "file_path", "path", "notebook_path"] as const;
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "NotebookEdit", "update-file"]);
export const isEditTool = (tool: string | undefined): boolean => !!tool && (EDIT_TOOLS.has(tool) || tool === "Write");

export function classifyApproval(a: Pick<PendingApproval, "toolName" | "args" | "argsSummary">, projectRoot: string | null): Risk {
  const tool = a.toolName ?? "";
  const args = (a.args ?? {}) as Record<string, unknown>;
  const named = [...new Set(PATH_KEYS.map((k) => str(args[k])).filter((v): v is string => v !== null))];
  const path = named[0] ?? null;
  const conflicting = named.length > 1;
  const reasons: string[] = [];
  let outsideProject = false;
  const problem = path ? (conflicting ? "names more than one path" : pathProblem(path, projectRoot)) : null;
  if (problem) { outsideProject = true; reasons.push(problem); }

  if (EDIT_TOOLS.has(tool) || tool === "Write") {
    // An edit with no usable path is unknown, not "inside the project": it is never batched and never gets a rule.
    const pathKnown = path !== null && !conflicting && problem === null;
    if (path === null) reasons.push("does not name a file, so it cannot be checked");
    if (tool === "Write") {
      const overwrite = args.exists === true;
      if (overwrite) reasons.push("overwrites an existing file");
      return { risk: overwrite ? "overwrite" : "create", label: overwrite ? "Overwrite file" : "New file", destructive: !pathKnown || overwrite, reasons, path, outsideProject, pathKnown, opaque: false };
    }
    if (args.replaceAll === true) reasons.push("replaces every occurrence in the file");
    return { risk: "edit", label: "Edit file", destructive: !pathKnown, reasons, path, outsideProject, pathKnown, opaque: false };
  }
  if (tool === "Bash" || tool === "run-bash") {
    const cmd = str(args.command) ?? a.argsSummary ?? "";
    const an = analyzeCommand(cmd);
    // Advisory: `destructive` only drives warnings and "ask one at a time". Nothing grants anything because it is false.
    return { risk: "command", label: "Run command", destructive: an.reasons.length > 0, reasons: an.reasons, path: null, outsideProject: false, pathKnown: false, opaque: an.opaque };
  }
  if (tool === "SandboxNetworkAccess" || tool === "WebFetch" || tool === "WebSearch") {
    return { risk: "network", label: "Network access", destructive: true, reasons: ["reaches a host outside this computer"], path: null, outsideProject: false, pathKnown: false, opaque: false };
  }
  if (tool.startsWith("mcp__")) {
    return { risk: "extension", label: "Extension tool", destructive: true, reasons: ["runs a tool from an installed extension; asked every time"], path, outsideProject, pathKnown: false, opaque: false };
  }
  return { risk: "unknown", label: "Tool call", destructive: true, reasons: ["this kind of tool is not recognised"], path, outsideProject, pathKnown: false, opaque: false };
}

/** What the card title says. Wire names are never shown alone: the SDK built-ins and kebab-case tools get words. */
export function toolTitle(toolName: string | undefined): string {
  const raw = toolName ?? "tool";
  const n = (raw.startsWith("mcp__") ? raw.slice(raw.lastIndexOf("__") + 2) : raw).toLowerCase();
  const t: Record<string, string> = {
    edit: "Edit a file", multiedit: "Edit a file", notebookedit: "Edit a notebook", "update-file": "Edit a file", write: "Write a file",
    bash: "Run a command", "run-bash": "Run a command", sandboxnetworkaccess: "Allow network access", webfetch: "Fetch a page", websearch: "Search the web", "git-op": "Run a git operation",
  };
  return t[n] ?? (raw.startsWith("mcp__") ? `Use extension tool ${n}` : `Use ${n}`);
}
