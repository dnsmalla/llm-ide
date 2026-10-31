// Risk class of a parked tool approval, from the tool name and its arguments only. Pure; deliberately
// conservative: anything not recognised is "unknown" and is never batched or offered a saved rule here.
import type { PendingApproval } from "../state";

export type RiskClass = "edit" | "create" | "overwrite" | "command" | "network" | "extension" | "unknown";

export interface Risk {
  risk: RiskClass;
  /** Short label for the card header badge. */
  label: string;
  /** Can destroy or exfiltrate data, or reach outside the project: never batched, never offered a saved rule. */
  destructive: boolean;
  /** Plain reasons, shown on the card. */
  reasons: string[];
  /** The file the tool touches, when it names one. */
  path: string | null;
  /** The file is outside the open project root (or the root is unknown while the path is absolute). */
  outsideProject: boolean;
}

const DESTRUCTIVE_COMMAND: ReadonlyArray<[RegExp, string]> = [
  [/\brm\s+(?:-[a-zA-Z]*[rRfF][a-zA-Z]*|--recursive|--force)\b/, "deletes files recursively or by force"],
  [/\bsudo\b|\bdoas\b/, "runs with elevated privileges"],
  [/\bgit\s+push\b[^|;&\n]*(?:--force|--force-with-lease|\s-f\b)/, "force-pushes history"],
  [/\bgit\s+reset\s+--hard\b|\bgit\s+clean\s+-[a-zA-Z]*f|\bgit\s+checkout\s+--\s|\bgit\s+branch\s+-D\b/, "discards uncommitted work or branches"],
  [/\b(?:curl|wget)\b[^|\n]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/, "pipes a download into a shell"],
  [/\bchmod\s+-R\b|\bchown\s+-R\b/, "changes permissions recursively"],
  [/\bmkfs\b|\bdd\s+if=|>\s*\/dev\/(?:sd|nvme|disk)|\bshred\b/, "writes to disks or devices"],
  [/\bfind\b[^|;\n]*\s-delete\b|\bxargs\s+rm\b/, "deletes files in bulk"],
  [/\bdrop\s+(?:table|database|schema)\b|\btruncate\s+table\b/i, "drops database data"],
  [/\beval\b|\bbase64\s+(?:-d|--decode)\b[^|\n]*\|\s*(?:ba|z)?sh\b/, "runs generated code"],
  [/:\(\)\s*\{/, "is a fork bomb"],
];

const norm = (p: string): string => {
  const parts: string[] = [];
  for (const seg of p.replace(/\\/g, "/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop(); else parts.push(seg);
  }
  return parts.join("/");
};
const isAbs = (p: string) => p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\");

/** True when `path` is inside `root` after resolving `.` and `..` textually. A relative path is judged against the root. */
export function insideRoot(path: string, root: string | null): boolean {
  if (!root) return !isAbs(path) && !norm(path).startsWith("..") && !path.replace(/\\/g, "/").split("/").includes("..");
  const r = norm(root);
  const joined = isAbs(path) ? norm(path) : norm(`${root}/${path}`);
  return joined === r || joined.startsWith(`${r}/`);
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

export function classifyApproval(a: Pick<PendingApproval, "toolName" | "args" | "argsSummary">, projectRoot: string | null): Risk {
  const tool = a.toolName ?? "";
  const args = (a.args ?? {}) as Record<string, unknown>;
  const path = str(args.filePath) ?? str(args.file_path) ?? str(args.path) ?? str(args.notebook_path);
  const reasons: string[] = [];
  let outsideProject = false;
  if (path && !insideRoot(path, projectRoot)) { outsideProject = true; reasons.push("touches a path outside the open project"); }

  if (tool === "Edit" || tool === "MultiEdit" || tool === "NotebookEdit" || tool === "update-file") {
    if (args.replaceAll === true) reasons.push("replaces every occurrence in the file");
    return { risk: "edit", label: "Edit file", destructive: outsideProject, reasons, path, outsideProject };
  }
  if (tool === "Write") {
    const overwrite = args.exists === true;
    if (overwrite) reasons.push("overwrites an existing file");
    return { risk: overwrite ? "overwrite" : "create", label: overwrite ? "Overwrite file" : "New file", destructive: outsideProject || overwrite, reasons, path, outsideProject };
  }
  if (tool === "Bash" || tool === "run-bash") {
    const cmd = str(args.command) ?? a.argsSummary ?? "";
    for (const [re, why] of DESTRUCTIVE_COMMAND) if (re.test(cmd)) reasons.push(why);
    return { risk: "command", label: "Run command", destructive: reasons.length > 0, reasons, path: null, outsideProject: false };
  }
  if (tool === "SandboxNetworkAccess" || tool === "WebFetch" || tool === "WebSearch") {
    return { risk: "network", label: "Network access", destructive: true, reasons: ["reaches a host outside this computer"], path: null, outsideProject: false };
  }
  if (tool.startsWith("mcp__")) {
    return { risk: "extension", label: "Extension tool", destructive: true, reasons: ["runs a tool from an installed extension; asked every time"], path, outsideProject };
  }
  return { risk: "unknown", label: "Tool call", destructive: true, reasons: ["this kind of tool is not recognised"], path, outsideProject };
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
