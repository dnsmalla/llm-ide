// Protected-path guard for agent edits. Mirrors the Mac's default groups: tests, build/verify config, the Loop's
// machine data and its own contract. `!glob` exemptions are supported; a bare "!" is ignored. The runner reverts a
// protected path through the host and fails the stage rather than letting a repair rewrite the verdict.
// CI and hook files are protected for EVERY stage, including Factory Implement: an agent that may write tests by
// design must still not rewrite the pipeline that judges it (R-036 A5).
export const CI_HOOK_PROTECTED_GLOBS = [
  ".github/workflows/**", "**/.github/workflows/**",
  ".gitlab-ci.yml", "**/.gitlab-ci.yml",
  ".husky/**", "**/.husky/**",
  ".circleci/**", "**/.circleci/**",
  "lefthook.yml", "**/lefthook.yml",
  ".pre-commit-config.yaml", "**/.pre-commit-config.yaml",
];

export const DEFAULT_PROTECTED_GLOBS = [
  "**/Tests/**", "**/tests/**", "**/test/**", "**/__tests__/**",
  "**/*Tests.swift", "**/*Test.swift", "**/*.test.mjs", "**/*.test.ts", "**/*.test.js", "**/*.test.tsx",
  "**/*_test.go", "**/test_*.py", "**/*_test.py", "**/*.spec.ts", "**/*.spec.js",
  "Makefile", "**/Makefile", "**/Package.swift", "**/package.json", "pytest.ini", "**/pytest.ini",
  "**/pyproject.toml", "**/setup.cfg", ".githooks/**", "**/.githooks/**", "**/jest.config.js", "**/vitest.config.ts",
  ...CI_HOOK_PROTECTED_GLOBS,
  "**/system/faults.csv", "**/system/faults/**", "**/system/loop-runs/**", "**/system/loop/**", "**/system/loop.json",
];

// Files the Ship panel calls out before the final confirm: a change to the build, the pipeline or a hook is the kind
// of thing a Review can miss. Tests are not listed (Implement writes them by design and Review judges them).
export const SENSITIVE_SHIP_GLOBS = [
  "package.json", "**/package.json", "Makefile", "**/Makefile", ".githooks/**", "**/.githooks/**",
  ...CI_HOOK_PROTECTED_GLOBS,
];

/** A glob match; case-insensitive so a `.GitHub/workflows` or `.FACTORY` spelling on a case-folding filesystem is the same path. */
function globMatch(glob: string, path: string): boolean {
  return globRe(glob).test(path) || globRe(glob.toLowerCase()).test(path.toLowerCase());
}

function globRe(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") { i++; if (glob[i + 1] === "/") { out += "(?:.*/)?"; i++; } else out += ".*"; }
      else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

export function isProtectedPath(path: string, extra: readonly string[] = []): boolean {
  const globs = [...DEFAULT_PROTECTED_GLOBS, ...extra];
  let hit = false;
  for (const glob of globs) {
    if (glob.startsWith("!")) {
      const pattern = glob.slice(1).trim();
      if (pattern && globMatch(pattern, path)) return false;
    } else if (!hit && globMatch(glob, path)) hit = true;
  }
  return hit;
}

/** True when `path` is a CI pipeline or hook file (protected even for the Implement stage). */
export function isCiHookPath(path: string): boolean {
  return CI_HOOK_PROTECTED_GLOBS.some((glob) => globMatch(glob, path));
}

/** The changed files the Ship panel lists as sensitive (build config, CI, hooks), in diff order. */
export function sensitiveChangedFiles(paths: readonly string[]): string[] {
  return [...new Set(paths.filter((p) => SENSITIVE_SHIP_GLOBS.some((glob) => globMatch(glob, p))))];
}

export function protectedPaths(paths: readonly string[], extra: readonly string[] = []): string[] {
  return [...new Set(paths.filter((p) => isProtectedPath(p, extra)))];
}

/**
 * Scope check (the Mac's `outOfScopePaths`): when the loop has scope globs, a changed path that matches none of them
 * is out of scope. Blank globs are ignored and an empty list means unrestricted. The caller applies the protected-path
 * policy to the result; this function only reports.
 */
export function outOfScopePaths(paths: readonly string[], scopeGlobs: readonly string[]): string[] {
  const globs = scopeGlobs.map((g) => g.trim()).filter(Boolean);
  if (globs.length === 0) return [];
  return [...new Set(paths.filter((p) => !globs.some((g) => scopeMatches(p, g))))];
}

/**
 * The Mac's `GlobMatch.matches`: a pattern with no glob character (`*`, `?`, `[`), or one ending in "/", is a directory
 * prefix ("src" and "src/" both cover src/a.ts); anything else is a glob.
 */
export function scopeMatches(path: string, pattern: string): boolean {
  if (!/[*?[]/.test(pattern)) {
    const dir = pattern.endsWith("/") ? pattern : `${pattern}/`;
    return path === pattern || path.startsWith(dir);
  }
  return globRe(pattern).test(path);
}

/**
 * True when `path` had uncommitted changes in the pre-edit snapshot (`loop_changed_paths`), so a revert would discard
 * them. git reports an untracked directory as "dir/", so anything under one counts as dirty too.
 */
export function wasDirtyBefore(path: string, before: ReadonlySet<string>): boolean {
  if (before.has(path)) return true;
  for (const b of before) if (b.endsWith("/") && path.startsWith(b)) return true;
  return false;
}

export type RevertPlan =
  | { revert: true; paths: string[]; created: string[] }
  | { revert: false; reason: string };

/**
 * Whether a revert may run for `paths`. Shared by the Loop and Auto Tasks. Nothing is reverted when the pre-run snapshot
 * failed or any path had uncommitted changes before the run. Otherwise the paths are reverted, and only the files the
 * agent's own Write created (`created`, the run's createdPaths) may be deleted.
 */
export function revertPlan(paths: readonly string[], before: ReadonlySet<string> | null, created: readonly string[]): RevertPlan {
  if (!before) return { revert: false, reason: "the pre-run snapshot failed, so nothing was reverted" };
  const dirty = paths.filter((p) => wasDirtyBefore(p, before));
  if (dirty.length > 0) return { revert: false, reason: `${dirty.join(", ")} had uncommitted changes before the run, so nothing was reverted and they were left in place` };
  return { revert: true, paths: [...paths], created: created.filter((p) => paths.includes(p)) };
}

export interface WritePolicy {
  /** "revert" undoes the violating paths, "stop" leaves them and halts, "warn" only logs, "off" checks nothing. */
  policy: string;
  extraProtectedGlobs: readonly string[];
  scopeGlobs: readonly string[];
}

/**
 * Applies the protected-path and scope policy to the paths one agent call wrote. Returns the halt message when the run
 * must stop (any violation under revert or stop), or null when the writes are acceptable. `revert` is injected so the
 * decision stays testable; the Loop's host call goes through it.
 */
export async function checkWrites(
  paths: readonly string[],
  input: WritePolicy,
  before: ReadonlySet<string> | null,
  created: readonly string[],
  revert: (paths: string[], created: string[]) => Promise<void>,
  log: (line: string) => void = () => undefined,
): Promise<string | null> {
  if (input.policy === "off") return null;
  const protectedHits = protectedPaths(paths, input.extraProtectedGlobs);
  const scopeHits = outOfScopePaths(paths, input.scopeGlobs).filter((p) => !protectedHits.includes(p));
  const bad = [...protectedHits, ...scopeHits];
  if (bad.length === 0) return null;
  const what = [protectedHits.length ? "protected path(s)" : "", scopeHits.length ? "out-of-scope path(s)" : ""].filter(Boolean).join(" and ");
  if (input.policy === "warn") {
    log(`warning: agent touched ${what}; the policy is warn, so the run continues: ${bad.join(", ")}`);
    return null;
  }
  if (input.policy === "stop") return `agent touched ${what} and they were left in place: ${bad.join(", ")}`;
  const plan = revertPlan(bad, before, created);
  if (!plan.revert) return `agent touched ${what}; ${plan.reason}: ${bad.join(", ")}`;
  try {
    await revert(plan.paths, plan.created);
    return `agent touched ${what} and they were reverted: ${bad.join(", ")}`;
  } catch (e) {
    return `agent touched ${what} and the revert failed: ${bad.join(", ")} (${e instanceof Error ? e.message : String(e)})`;
  }
}
