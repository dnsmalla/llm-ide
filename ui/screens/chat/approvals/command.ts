// Shell command hygiene for the approval UI. ADVISORY ONLY.
//
// A regex over shell text can never prove a command safe (quoting, expansion, aliases and the program's own flags
// all change what runs). This module therefore does two different jobs and the callers must not confuse them:
//   1. `analyzeCommand` lists reasons a command looks dangerous or opaque, for the card's warnings. "No reasons"
//      means "nothing recognised", NEVER "safe".
//   2. `commandWords` gives the normalised words of a command so a POSITIVE allowlist (rules.ts) can decide what a
//      saved rule may cover. Saved rules, batching and any auto-allow are gated on that allowlist, not on this list.
// Pure.

/** Whitespace look-alikes and zero-width characters that make `rm<NBSP>-rf` read as one word or hide a letter. */
const SPACE_LIKE = /[\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/g;
const ZERO_WIDTH = /[\u00AD\u034F\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\uFE00-\uFE0F\u{E0000}-\u{E007F}]/gu;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

export interface NormalizedCommand {
  /** Lower-case, quotes and backslashes removed, whitespace collapsed, line continuations joined. */
  text: string;
  /** Hidden or look-alike characters were present in the raw command. */
  hadHidden: boolean;
}

export function normalizeCommand(raw: string): NormalizedCommand {
  let hadHidden = false;
  let s = raw.replace(/\\\r?\n/g, "");
  s = s.replace(SPACE_LIKE, () => { hadHidden = true; return " "; });
  s = s.replace(ZERO_WIDTH, () => { hadHidden = true; return ""; });
  s = s.replace(CONTROL, () => { hadHidden = true; return " "; });
  s = s.replace(/\r\n?/g, "\n");
  s = s.replace(/["'\\]/g, "");
  s = s.replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n").trim().toLowerCase();
  return { text: s, hadHidden };
}

const WRAPPERS = new Set(["sudo", "doas", "env", "command", "builtin", "nohup", "time", "exec", "nice", "ionice", "xargs", "stdbuf", "timeout", "then", "do", "else", "!", "if", "while", "until", "{", "(", "caffeinate"]);
const INTERPRETERS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "csh", "tcsh", "python", "python2", "python3", "perl", "ruby", "node", "deno", "bun", "php", "lua", "osascript", "pwsh", "powershell", "awk", "gawk", "npx", "tsx", "ts-node", "source", "."]);
const NETWORK = new Set(["curl", "wget", "nc", "ncat", "netcat", "socat", "telnet", "scp", "sftp", "ftp", "rsync", "ssh", "ssh-copy-id", "aria2c", "http", "https"]);
const KILLERS = new Set(["kill", "killall", "pkill"]);
const DELETERS = new Set(["rm", "rmdir", "unlink", "srm", "shred", "truncate"]);
const DISK = new Set(["dd", "mkfs", "fdisk", "diskutil", "parted", "wipefs", "format"]);

const base = (p: string): string => (p.includes("/") ? p.slice(p.lastIndexOf("/") + 1) : p);
const isAssign = (t: string) => /^[a-z_][a-z0-9_]*\+?=/.test(t);
const SHORT = (flags: string[], chars: string): boolean => flags.some((f) => /^-[a-z]+$/.test(f) && [...chars].some((c) => f.includes(c)));

/** Segments of a command line (split on ; && || | & newlines and grouping), each as its normalised words. */
export function commandSegments(normalized: string): string[][] {
  const masked = normalized.replace(/\d*[<>]&\d*-?/g, " ").replace(/&>>?/g, " > ");
  return masked.split(/;|&&|\|\||\||&|\n|\(|\)|\{|\}/).map((seg) => seg.trim().split(" ").filter(Boolean)).filter((t) => t.length > 0);
}

/** The program and its arguments for one segment, with leading wrappers and assignments skipped. */
function programOf(tokens: string[]): { program: string; args: string[]; wrappers: string[]; assigned: boolean } {
  let i = 0;
  const wrappers: string[] = [];
  let assigned = false;
  while (i < tokens.length) {
    const t = tokens[i];
    if (isAssign(t)) { assigned = true; i++; continue; }
    if (WRAPPERS.has(base(t))) {
      wrappers.push(base(t)); i++;
      while (i < tokens.length && (tokens[i].startsWith("-") || isAssign(tokens[i]))) { if (isAssign(tokens[i])) assigned = true; i++; }
      continue;
    }
    break;
  }
  return { program: base(tokens[i] ?? ""), args: tokens.slice(i + 1), wrappers, assigned };
}

const GIT_GLOBAL_WITH_VALUE = new Set(["--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix", "--config-env"]);
function gitParts(args: string[]): { sub: string; rest: string[] } {
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === "-c" || a === "-C" || GIT_GLOBAL_WITH_VALUE.has(a)) { i += 2; continue; }
    if (a.startsWith("-")) { i++; continue; }
    break;
  }
  return { sub: args[i] ?? "", rest: args.slice(i + 1) };
}

function gitReasons(sub: string, rest: string[]): string[] {
  const out: string[] = [];
  const has = (...f: string[]) => rest.some((a) => f.includes(a));
  switch (sub) {
    case "push":
      if (rest.some((a) => a === "--force" || a.startsWith("--force-with-lease") || a === "--delete" || a === "--mirror" || a === "--prune" || /^-[a-z]*[fd]/.test(a) || (a.startsWith("+") && a.length > 1) || /^:[^:]/.test(a))) out.push("force-pushes or deletes remote history");
      break;
    case "reset": out.push("moves the branch or discards uncommitted work"); break;
    case "clean": if (!has("-n", "--dry-run")) out.push("deletes untracked files"); break;
    case "checkout": case "switch":
      if (rest.some((a) => a === "." || a === "--" || a === "-f" || a === "--force" || a === "-b" || a === "-B" || a === "*" || a === ":/" || a === "--discard-changes")) out.push("discards uncommitted work or resets a branch");
      break;
    case "restore": if (!(has("--staged") && !has("--worktree", "-w"))) out.push("discards uncommitted work"); break;
    case "stash": if (has("drop", "clear")) out.push("drops stashed work"); break;
    case "branch": if (rest.some((a) => a === "-D" || a === "-d" || a === "--delete" || a === "-f" || a === "--force" || a === "-m" || a === "-M")) out.push("deletes or force-moves branches"); break;
    case "tag": if (has("-d", "--delete", "-f")) out.push("deletes tags"); break;
    case "filter-branch": case "filter-repo": case "update-ref": case "prune": case "replace":
      out.push("rewrites repository history"); break;
    case "reflog": if (has("expire", "delete")) out.push("deletes the reflog"); break;
    case "gc": if (rest.some((a) => a.startsWith("--prune"))) out.push("prunes unreachable commits"); break;
    case "worktree": if (has("remove", "prune")) out.push("removes worktrees"); break;
    case "submodule": if (has("deinit")) out.push("removes submodules"); break;
    default:
  }
  return out;
}

export interface CommandAnalysis {
  /** Plain reasons the command looks dangerous (advisory). */
  reasons: string[];
  /** The command uses a construct that hides what really runs (expansion, substitution, eval, encoding, env prefixes, hidden characters). */
  opaque: boolean;
}

const OPAQUE_RAW: ReadonlyArray<[RegExp, string]> = [
  [/\$\(|`/, "contains command substitution, so what runs is not visible here"],
  [/<\(|>\(/, "contains process substitution, so what runs is not visible here"],
  [/\$\{?[a-z_@*#?!0-9]/i, "expands variables, so the real command is not visible here"],
  [/<<-?\s*['"]?\w/, "contains a here-document"],
];

/** Everything recognisable as dangerous or opaque. Best effort: an empty result means nothing recognised, not safe. */
export function analyzeCommand(raw: string): CommandAnalysis {
  const reasons: string[] = [];
  const add = (r: string) => { if (!reasons.includes(r)) reasons.push(r); };
  let opaque = false;
  const rawNoCont = raw.replace(/\\\r?\n/g, "");
  for (const [re, why] of OPAQUE_RAW) if (re.test(rawNoCont)) { opaque = true; add(why); }
  const n = normalizeCommand(raw);
  if (n.hadHidden) { opaque = true; add("contains hidden or look-alike characters"); }
  const text = n.text;
  // After quote removal a variable in the program position (r""m $X ${RM}) or a `$` anywhere is still opaque.
  if (/\$/.test(text) && !opaque) { opaque = true; add("expands variables, so the real command is not visible here"); }
  if (/\beval\b/.test(text)) { opaque = true; add("runs generated code (eval)"); }
  if (/\bbase64\b/.test(text)) { opaque = true; add("decodes or encodes data with base64, which can hide what runs"); }

  // A download piped into an interpreter, in any spelling.
  if (/\b(?:curl|wget|fetch)\b[^;&\n]*\|\s*(?:[^|;&\n ]*\/)?(?:sudo\s+(?:-\S+\s+)*)?(?:[bzdk]?a?sh|csh|tcsh|fish|python[0-9.]*|perl|ruby|node|php|deno|bun|source|eval|xargs)\b/.test(text)
    || /<\(\s*(?:curl|wget)\b/.test(text)) add("pipes a download into a shell or interpreter");
  // Redirection that writes a file (not `2>&1`, not into /dev/null).
  const redirect = text.replace(/\d*[<>]&\d*-?/g, " ").replace(/\d*>>?\s*\/dev\/null\b/g, " ");
  if (/>/.test(redirect)) add("writes to a file through a redirection");
  if (/:\(\)\s*\{/.test(text)) add("is a fork bomb");
  if (/\bdrop\s+(?:table|database|schema)\b|\btruncate\s+table\b/.test(text)) add("drops database data");

  for (const tokens of commandSegments(text)) {
    const p = programOf(tokens);
    if (p.assigned) { opaque = true; add("sets environment variables before the program"); }
    for (const w of p.wrappers) {
      if (w === "sudo" || w === "doas") add("runs with elevated privileges");
      if (w === "xargs") add("runs another command on a list of inputs");
      if (w === "exec" || w === "env") { opaque = true; add("runs another program through a wrapper"); }
    }
    const { program: prog, args } = p;
    if (!prog) continue;
    const flags = args.filter((a) => a.startsWith("-"));
    if (prog === "su" || prog === "pkexec") add("runs with elevated privileges");
    const rmWide = prog === "rm" && (SHORT(flags, "rf") || flags.some((f) => f === "--recursive" || f === "--force" || f === "--no-preserve-root") || args.some((a) => a.includes("*") || a === "/" || a === "~" || a === "."));
    if (rmWide) add("deletes files recursively, by force or by pattern");
    else if (DELETERS.has(prog)) add(prog === "truncate" ? "truncates files" : "deletes files");
    if (prog === "mv" || prog === "ln") { if (args.some((a) => a === "/dev/null") || flags.some((f) => f === "-f" || f === "--force")) add("moves or replaces files, possibly discarding them"); else add("moves or replaces files"); }
    if (prog === "git") { const g = gitParts(args); for (const r of gitReasons(g.sub, g.rest)) add(r); }
    if (DISK.has(prog) || prog.startsWith("mkfs")) add("writes to disks or devices");
    if (/^\/dev\/(?:sd|nvme|disk|rdisk)/.test(args.join(" "))) add("writes to disks or devices");
    if ((prog === "chmod" || prog === "chown" || prog === "chgrp") && (SHORT(flags, "r") || flags.includes("--recursive"))) add("changes permissions or ownership recursively");
    if (prog === "find" && args.some((a) => ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprintf", "-fls"].includes(a))) add("runs commands or deletes files for every match (find)");
    if (KILLERS.has(prog)) add("stops processes");
    if (prog === "sed" && (SHORT(flags, "i") || flags.some((f) => f.startsWith("--in-place")))) add("edits files in place");
    if (prog === "perl" && SHORT(flags, "i")) add("edits files in place");
    if (prog === "tee") add("writes to files");
    if (prog === "crontab" || prog === "launchctl" || prog === "systemctl") add("changes scheduled or background jobs");
    if (NETWORK.has(prog)) add("sends or fetches data over the network");
    if (INTERPRETERS.has(prog)) {
      add("runs a script or interpreter");
      if (flags.some((f) => f === "-c" || f === "-e" || f === "-r" || f === "-command" || f === "--eval" || f === "-ec" || f === "-lc" || /^-[a-z]*[ce]$/.test(f))) { opaque = true; add("runs inline code passed as text"); }
    }
    if (prog === "source" || prog === ".") add("runs a script in the current shell");
  }
  return { reasons, opaque };
}

/** Normalised words of the FIRST simple command, wrappers kept (the allowlist treats any wrapper as disqualifying). */
export function commandWords(raw: string): { words: string[]; compound: boolean; opaque: boolean } {
  const n = normalizeCommand(raw);
  const segs = commandSegments(n.text);
  const a = analyzeCommand(raw);
  return { words: segs[0] ?? [], compound: segs.length > 1 || /[;&|<>`$\n]/.test(n.text), opaque: a.opaque };
}
