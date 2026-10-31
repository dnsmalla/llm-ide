// "Always allow" rules: what the server offered (`suggestion`), shown exactly before anything is saved. Pure.
import type { ApprovalSuggestion } from "../events";
import type { Risk } from "./risk";
import { commandWords } from "./command";
import { hasHidden, sanitizeText } from "./sanitize";

const EDIT_RULE_TOOLS: ReadonlySet<string> = new Set(["Edit", "MultiEdit", "NotebookEdit", "Write", "update-file"]);

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

/**
 * What a SAVED "always allow" rule may ever cover: a short POSITIVE list of read-only inspection commands. A saved rule
 * is a prefix, so it also covers every argument and everything the user will never see again; the risk classifier
 * (risk.ts) is advisory and is deliberately not consulted to widen this list.
 *
 * Why these: they only read repository or file-system metadata and execute no project code.
 * Why not the obvious others:
 *   cat/head/tail/less  read secrets (~/.aws/credentials, ~/.ssh/id_rsa) and the output goes to the model
 *   echo/printf/tee     a prefix rule cannot stop `echo x > file`
 *   npm/yarn/pnpm/make/cargo/pytest/go  run project code (scripts, build hooks, tests) with the user's rights
 *   git branch/checkout/restore/reset/clean/push/stash/rebase/commit  change or discard state
 *   find (-exec/-delete), xargs, env, sudo, sh/bash/zsh, python/node/perl/ruby, ssh, curl, wget, eval, exec  run anything
 * `git diff/log/show` accept `--output=<file>`; that residual risk is stated on the confirmation card.
 */
interface Allowed { words: readonly string[]; /** The rule must be exactly these words (no further arguments). */ exact?: boolean }
export const SAFE_RULE_PREFIXES: readonly Allowed[] = [
  { words: ["git", "status"] }, { words: ["git", "diff"] }, { words: ["git", "log"] }, { words: ["git", "show"] },
  { words: ["ls"] }, { words: ["which"] },
  { words: ["git", "--version"], exact: true },
];

/** Programs that make a prefix rule cover arbitrary code. Checked against EACH of the first two words (after path stripping), whatever the allowlist says. */
const NEVER_IN_PREFIX = new Set([
  "sh", "bash", "zsh", "fish", "dash", "ksh", "csh", "tcsh", "sudo", "doas", "su", "env", "eval", "exec", "xargs", "find", "node", "python", "python2", "python3",
  "perl", "ruby", "php", "deno", "bun", "npx", "tsx", "ts-node", "ssh", "curl", "wget", "nc", "ncat", "netcat", "socat", "nohup", "time", "command", "builtin", "source", ".", "*",
  "awk", "gawk", "osascript", "pwsh", "powershell", "lua", "-c", "-e", "-exec", "-execdir", "-delete", "-ok",
]);

export type RuleCheck = { ok: true; view: RuleView } | { ok: false; reason: string };

const base = (p: string) => (p.includes("/") ? p.slice(p.lastIndexOf("/") + 1) : p);

/**
 * Whether to offer "always allow" and how to word it. `projectRoot` is the root THE TURN was sent with (what the core
 * scopes the rule to), not the project currently open. `command` is the Bash command being approved right now.
 *
 *  - session rule ("Allow all edits in this chat"): only for a single edit/write that names one path textually inside the root;
 *  - project rule: only for Bash, only for a normalised pattern that starts with an allowlisted read-only command
 *    plus at least one more word, with no interpreter/shell/sudo/env/xargs/find/eval/exec/ssh/curl/wget in the first
 *    two words, matching the command being approved, and only when that command is a single plain command.
 * Everything else is approved one call at a time.
 */
export function describeRule(sug: ApprovalSuggestion | null | undefined, risk: Risk, projectRoot: string | null, command?: string | null): RuleCheck {
  if (!sug) return { ok: false, reason: "No saved rule is offered for this call." };
  const root = projectRoot ? sanitizeText(projectRoot, 300).text : null;
  if (sug.scope === "session") {
    const named = sug.toolName === undefined || EDIT_RULE_TOOLS.has(sug.toolName);
    if ((risk.risk !== "edit" && risk.risk !== "create") || !named) return { ok: false, reason: "This call is not a plain file edit, so it is approved one at a time." };
    if (!risk.pathKnown || risk.outsideProject || risk.destructive || !root) return { ok: false, reason: "This edit is outside the usual limits and is approved one at a time." };
    return { ok: true, view: { scope: "session", button: "Allow all edits in this chat", exact: "Edit and Write calls in this chat", scopeText: `This chat only, until it is closed, for work in ${root}. Other chats still ask. Commands still ask.`, revoke: "Ends with the chat." } };
  }
  if (risk.risk !== "command") return { ok: false, reason: "A saved rule is only offered for a short list of read-only shell commands. This call is approved one at a time." };
  if (risk.destructive || risk.opaque) return { ok: false, reason: "This call is approved one at a time: a saved rule never covers it." };
  if (!root) return { ok: false, reason: "No project is known for this turn, so a rule has nothing to be scoped to." };
  const tool = sug.toolName ?? "";
  if (tool !== "Bash" && tool !== "run-bash") return { ok: false, reason: "The offered rule is not for a shell command and was refused." };
  if (sug.pattern === undefined || !sug.pattern.trim()) return { ok: false, reason: "The offered rule covers every command and was refused." };
  if (hasHidden(sug.pattern)) return { ok: false, reason: "The offered rule contains hidden characters and was refused." };
  const pat = commandWords(sug.pattern);
  if (pat.compound || pat.opaque || pat.words.length === 0) return { ok: false, reason: "The offered rule is not a single plain command prefix and was refused." };
  const words = pat.words.map(base);
  const match = SAFE_RULE_PREFIXES.find((e) => e.words.every((w, i) => words[i] === w) && (!e.exact || words.length === e.words.length));
  if (!match) return { ok: false, reason: "Only a short list of read-only commands (git status/diff/log/show, ls, which) can be saved as a rule." };
  if (!match.exact && words.length < 2) return { ok: false, reason: "The offered rule has no argument and was refused." };
  if (!match.exact && words.slice(0, 2).some((w) => NEVER_IN_PREFIX.has(w))) return { ok: false, reason: "The offered rule is too broad to save." };
  if (command !== undefined && command !== null) {
    const cur = commandWords(command);
    if (cur.compound || cur.opaque || !words.every((w, i) => base(cur.words[i] ?? "") === w)) return { ok: false, reason: "The offered rule does not match this exact command, so it is not saved." };
  }
  const p = sanitizeText(sug.pattern.trim(), 200).text;
  return { ok: true, view: {
    scope: "project", button: `Always allow "${p}" here`,
    exact: `Bash: any command starting with "${p}", with any arguments`,
    scopeText: `Only in ${root}. Other projects still ask. The rule covers whatever follows "${p}", including options such as --output.`,
    revoke: "Revoke it in Settings, Tool permissions.",
  } };
}
