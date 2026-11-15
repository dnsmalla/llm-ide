// Project environment checks used by the Loop template/environment cards. This slice only DETECTS a test command
// from the project's manifest; it never runs a command. Running is a separate approval-gated host feature.
import type { FsApi } from "../../explorer/fs";

export type DetectFs = Pick<FsApi, "read"> & Partial<Pick<FsApi, "list">>;
export const DETECTED_TEST = "<detected-test-command>";
/** The Factory's Structure verify command until detection fills it; never the test command's placeholder. */
export const DETECTED_STRUCTURE = "<detected-structure-command>";

function codeOf(e: unknown): string {
  return typeof e === "object" && e !== null && typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : "";
}

async function exists(fs: DetectFs, path: string): Promise<boolean> {
  try {
    const r = await fs.read(path, 200_000);
    return r.status === "ok";
  } catch (e) {
    if (codeOf(e) === "missing" || codeOf(e) === "not_found") return false;
    return false;
  }
}

/** The Mac's ProjectEnvironmentInspector shape, limited to a test command the desktop can prove from a manifest. */
/**
 * The pytest command for this machine: `-m` runs pytest with the same interpreter that runs the code, so a stale `pytest`
 * launcher on the PATH cannot break it. Windows usually has `python`, not `python3` (the shell there is cmd.exe).
 */
export function pytestCommand(platform: string = typeof navigator !== "undefined" ? navigator.platform ?? "" : ""): string {
  return /^win/i.test(platform) ? "python -m pytest" : "python3 -m pytest";
}

export async function detectTestCommand(fs: DetectFs, prefix = ""): Promise<{ command: string | null; reason: string }> {
  const path = (name: string) => (prefix ? `${prefix}/${name}` : name);
  try {
    const pkg = await fs.read(path("package.json"), 500_000);
    if (pkg.status === "ok" && pkg.text) {
      const script = JSON.parse(pkg.text) as { scripts?: Record<string, unknown> };
      if (typeof script.scripts?.test === "string" && script.scripts.test.trim() !== "") {
        return { command: "npm test", reason: "package.json declares a test script." };
      }
    }
  } catch { /* no package.json */ }
  if (await exists(fs, path("Package.swift"))) return { command: "swift test", reason: "Swift Package manifest found." };
  if (await exists(fs, path("pyproject.toml")) || await exists(fs, path("pytest.ini")) || await exists(fs, path("tox.ini"))) return { command: pytestCommand(), reason: "Python test configuration found." };
  if (await exists(fs, path("Makefile"))) {
    try {
      const mk = await fs.read(path("Makefile"), 500_000);
      if (mk.status === "ok" && mk.text && /^test\s*:/m.test(mk.text)) return { command: "make test", reason: "Makefile has a test target." };
    } catch { /* ignore */ }
  }
  return { command: null, reason: "No test command could be detected from package.json, Package.swift, Python config or Makefile." };
}

export function applyDetected(command: string | null, configured: string | null): string | null {
  return configured === DETECTED_TEST ? command : configured;
}

/** A command that checks the code's structure without running it: lint script, TypeScript, or Ruff. */
export async function detectStructureCommand(fs: DetectFs, prefix = ""): Promise<{ command: string | null; reason: string }> {
  const path = (name: string) => (prefix ? `${prefix}/${name}` : name);
  try {
    const pkg = await fs.read(path("package.json"), 500_000);
    if (pkg.status === "ok" && pkg.text) {
      const parsed = JSON.parse(pkg.text) as { scripts?: Record<string, unknown> };
      if (typeof parsed.scripts?.lint === "string" && parsed.scripts.lint.trim() !== "") return { command: "npm run lint", reason: "package.json declares a lint script." };
    }
  } catch { /* no package.json */ }
  if (await exists(fs, path("tsconfig.json"))) return { command: "npx tsc --noEmit", reason: "tsconfig.json found." };
  if (await exists(fs, path("ruff.toml")) || await exists(fs, path(".ruff.toml"))) return { command: "ruff check .", reason: "Ruff configuration found." };
  try {
    const py = await fs.read(path("pyproject.toml"), 500_000);
    if (py.status === "ok" && py.text && /^\[tool\.ruff/m.test(py.text)) return { command: "ruff check .", reason: "pyproject.toml configures Ruff." };
  } catch { /* no pyproject.toml */ }
  return { command: null, reason: "No lint script, tsconfig.json or Ruff configuration found." };
}

/** Detect the structure check at the project root, else in the first linked clone under code/. */
export async function detectProjectStructureCommand(fs: DetectFs): Promise<{ command: string | null; prefix: string }> {
  const root = await detectStructureCommand(fs);
  if (root.command || !fs.list) return { command: root.command, prefix: "" };
  try {
    for (const e of (await fs.list("code")).entries) {
      if (e.kind !== "dir") continue;
      const found = await detectStructureCommand(fs, `code/${e.name}`);
      if (found.command) return { command: found.command, prefix: `code/${e.name}` };
    }
  } catch { /* no code folder */ }
  return { command: null, prefix: "" };
}

/** Detect the test command at the project root, else in the first linked clone under code/. */
export async function detectProjectTestCommand(fs: DetectFs): Promise<{ command: string | null; reason: string; prefix: string }> {
  const root = await detectTestCommand(fs);
  if (root.command) return { ...root, prefix: "" };
  if (!fs.list) return { ...root, prefix: "" };
  try {
    const entries = (await fs.list("code")).entries;
    for (const e of entries) {
      if (e.kind !== "dir") continue;
      const found = await detectTestCommand(fs, `code/${e.name}`);
      if (found.command) return { ...found, prefix: `code/${e.name}` };
    }
  } catch { /* no code folder */ }
  return { ...root, prefix: "" };
}
