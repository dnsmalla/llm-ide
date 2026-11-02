// Protected-path guard for agent edits. Mirrors the Mac's default groups: tests, build/verify config, the Loop's
// machine data and its own contract. `!glob` exemptions are supported; a bare "!" is ignored. The runner reverts a
// protected path through the host and fails the stage rather than letting a repair rewrite the verdict.
export const DEFAULT_PROTECTED_GLOBS = [
  "**/Tests/**", "**/tests/**", "**/test/**", "**/__tests__/**",
  "**/*Tests.swift", "**/*Test.swift", "**/*.test.mjs", "**/*.test.ts", "**/*.test.js", "**/*.test.tsx",
  "**/*_test.go", "**/test_*.py", "**/*_test.py", "**/*.spec.ts", "**/*.spec.js",
  "Makefile", "**/Makefile", "**/Package.swift", "**/package.json", "pytest.ini", "**/pytest.ini",
  "**/pyproject.toml", "**/setup.cfg", ".githooks/**", "**/jest.config.js", "**/vitest.config.ts",
  "**/system/faults.csv", "**/system/faults/**", "**/system/loop-runs/**", "**/system/loop/**", "**/system/loop.json",
];

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
      if (pattern && globRe(pattern).test(path)) return false;
    } else if (!hit && globRe(glob).test(path)) hit = true;
  }
  return hit;
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
