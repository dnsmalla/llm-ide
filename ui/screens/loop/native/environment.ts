// Project environment checks used by the Loop template/environment cards. This slice only DETECTS a test command
// from the project's manifest; it never runs a command. Running is a separate approval-gated host feature.
import type { FsApi } from "../../explorer/fs";

export type DetectFs = Pick<FsApi, "read">;
export const DETECTED_TEST = "<detected-test-command>";

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
  if (await exists(fs, path("pyproject.toml")) || await exists(fs, path("pytest.ini")) || await exists(fs, path("tox.ini"))) return { command: "pytest", reason: "Python test configuration found." };
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
