// "Always allow" rules: what the server offered (`suggestion`), shown exactly before anything is saved. Pure.
import type { ApprovalSuggestion } from "../events";
import type { Risk } from "./risk";
import { hasHidden, sanitizeText } from "./sanitize";

export interface RuleView {
  scope: "session" | "project";
  /** Button label. */
  button: string;
  /** The exact rule that would be stored, as text. */
  exact: string;
  /** Where it applies and for how long. */
  scopeText: string;
  /** Where to revoke it. */
  revoke: string;
}

/** Interpreters and wrappers that make a prefix rule cover arbitrary code: a rule that is only one of these is refused. */
const TOO_BROAD = new Set(["sh", "bash", "zsh", "fish", "dash", "sudo", "doas", "env", "eval", "exec", "xargs", "node", "python", "python3", "perl", "ruby", "php", "deno", "bun", "npx", "ssh", "curl", "wget", "nohup", "time", "command", "builtin", "source", ".", "*"]);

export type RuleCheck = { ok: true; view: RuleView } | { ok: false; reason: string };

/**
 * Whether to offer "always allow" and how to word it. Offered only for a rule the server proposed, in a project
 * (project rules), for a call that is not destructive, with a prefix that is neither empty, hidden-character
 * laced, nor a bare interpreter.
 */
export function describeRule(sug: ApprovalSuggestion | null | undefined, risk: Risk, projectRoot: string | null): RuleCheck {
  if (!sug) return { ok: false, reason: "No saved rule is offered for this call." };
  if (sug.scope === "session") {
    if (risk.destructive) return { ok: false, reason: "This edit is outside the usual limits and is approved one at a time." };
    return { ok: true, view: { scope: "session", button: "Allow all edits in this chat", exact: "Edit and Write calls in this chat", scopeText: "This chat only, until it is closed. Other chats still ask. Commands still ask.", revoke: "Ends with the chat." } };
  }
  if (risk.destructive) return { ok: false, reason: "This call is approved one at a time: a saved rule never covers it." };
  if (!projectRoot) return { ok: false, reason: "No project is open, so a rule has nothing to be scoped to." };
  const tool = sug.toolName ?? "";
  if (!tool || hasHidden(tool) || (sug.pattern !== undefined && hasHidden(sug.pattern))) return { ok: false, reason: "The offered rule contains hidden characters and was refused." };
  const pattern = sug.pattern?.trim() ?? "";
  if (sug.pattern !== undefined) {
    const first = pattern.split(/\s+/)[0] ?? "";
    if (!pattern || TOO_BROAD.has(first) && pattern.split(/\s+/).length < 2) return { ok: false, reason: "The offered rule is too broad to save." };
  }
  const p = sanitizeText(pattern, 200).text;
  const root = sanitizeText(projectRoot, 300).text;
  const exact = pattern ? `${sanitizeText(tool, 80).text}: commands starting with "${p}"` : `${sanitizeText(tool, 80).text}: every call`;
  return { ok: true, view: { scope: "project", button: pattern ? `Always allow "${p}" here` : `Always allow ${sanitizeText(tool, 80).text} here`, exact, scopeText: `Only in ${root}. Other projects still ask.`, revoke: "Revoke it in Settings, Tool permissions." } };
}
