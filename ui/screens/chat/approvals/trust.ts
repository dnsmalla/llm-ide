// Workspace trust wording and decisions. Port of the Mac's WorkspaceTrustPresentation (Core/Contracts/WorkspaceTrust.swift)
// so both apps say the same thing about the same notice. Names only: the core never sends a command line or env.
import type { WorkspaceTrustState } from "../state";
import { sanitizeText } from "./sanitize";

export type Skipped = WorkspaceTrustState["skipped"][number];

const clean = (s: string, cap = 120) => sanitizeText(s, cap).text;

export function displayName(path: string): string {
  const p = path.replace(/[\\/]+$/, "");
  const last = p.split(/[\\/]/).pop() ?? "";
  return clean(last || path, 200);
}

/** MCP entries that trusting would start or connect: stdio, remote (http/sse), and a `.mcp.json` that could not be read. */
export const withheld = (n: Pick<WorkspaceTrustState, "skipped">): Skipped[] => n.skipped.filter((s) => s.withheld && s.kind.startsWith("mcp-"));

const nameList = (items: Skipped[]): string => {
  const names = items.slice(0, 4).map((i) => clean(i.name, 60)).join(", ");
  return items.length > 4 ? `${names} and ${items.length - 4} more` : names;
};

/** One sentence per kind present; the program sentence only when a stdio server is listed. */
export function effectSentences(held: Skipped[]): string[] {
  const stdio = held.filter((h) => h.kind === "mcp-stdio");
  const remote = held.filter((h) => h.kind === "mcp-remote");
  const unread = held.filter((h) => h.kind === "mcp-uninspected");
  const out: string[] = [];
  if (stdio.length) out.push(`Each of these runs a program on this computer: ${nameList(stdio)}.`);
  if (remote.length) out.push(`Each of these connects to a remote endpoint: ${nameList(remote)}.`);
  if (unread.length) out.push("Its .mcp.json could not be read, so what it starts is unknown.");
  return out;
}

export function bannerText(n: WorkspaceTrustState): string {
  const folder = displayName(n.path);
  const held = withheld(n);
  if (held.length === 0) return `${folder} is not a trusted folder. It carries config that is never loaded here (hooks and plugins from a project folder are not loaded at all).`;
  const sentences = effectSentences(held);
  return `${folder} is not a trusted folder, so its own MCP servers were not started.${sentences.length ? ` ${sentences.join(" ")}` : ""}`;
}

const TAIL = "Hooks and plugins inside a project folder are not loaded either way. Only trust folders whose contents you wrote or have read. You can turn this off again in Settings.";

/** Shown before the explicit trust: names what will run. The path is the notice's own path, never re-typed. */
export function confirmationText(n: WorkspaceTrustState): { title: string; body: string[] } {
  const held = withheld(n);
  const sentences = effectSentences(held);
  const first = "From now on, chats in this folder start the MCP servers its .mcp.json file defines.";
  const second = sentences.length ? `${sentences.join(" ")} They run with your permissions.` : "A server it defines can run a program on this computer with your permissions or connect to a remote endpoint.";
  return { title: `Trust ${clean(n.path, 300)}?`, body: [first, second, TAIL] };
}

/** A plain sentence for a failed trust change. */
export function failureMessage(code: string | null, serverMessage: string | null): string {
  switch (code) {
    case "INVALID_PATH": return "That folder is too broad to trust as one project. Choose the project folder itself.";
    case "NOT_FOUND": return "That folder no longer exists, so it cannot be trusted.";
    default:
      if (serverMessage) return clean(serverMessage, 300);
      return "The trust setting could not be saved. Check that the local core is running and try again.";
  }
}

export function kindText(kind: string): string {
  switch (kind) {
    case "mcp-stdio": return "MCP server";
    case "mcp-remote": return "remote MCP server";
    case "mcp-uninspected": return "MCP file that could not be read";
    case "hooks": return "hooks";
    case "plugin": return "plugin";
    case "skill-scripts": return "skill with scripts";
    default: return clean(kind, 40);
  }
}
