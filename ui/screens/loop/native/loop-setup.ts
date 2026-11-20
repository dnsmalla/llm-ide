// Dependencies for a loop's worktree run. A worktree starts from the repository's files only, so a loop that runs the
// project's tests needs the same install step the Factory runs (`setupCommandFor`: npm ci, swift build). The step is an
// ordinary saved "Set up" stage (so the native approval pins its exact command) that a run keeps on only when needed:
// nothing is installed yet, or the lockfile changed since the last install in this worktree.
import type { FsApi } from "../../explorer/fs";
import { decodeStage, type LoopDefinition, type LoopStage } from "./model.ts";
import { isFactoryLoop, setupCommandFor } from "./factory.ts";
import { runsInWorktree } from "./worktree-run.ts";

const SETUP_ID_PREFIX = "loop/setup-";
export const isSetupStage = (s: Pick<LoopStage, "id">): boolean => s.id.startsWith(SETUP_ID_PREFIX);

/** Where each install step puts its result and which file pins its inputs. */
const INSTALLS: Record<string, { dir: string; lockfile: string }> = {
  "npm ci": { dir: "node_modules", lockfile: "package-lock.json" },
  "swift build": { dir: ".build", lockfile: "Package.resolved" },
};

/**
 * The loop with a "Set up" stage first, when it runs the project's tests in a worktree and the detected test command
 * implies an install step. A loop that already has the step, the Factory (own Set up stage) and a loop that works in
 * the main tree (an install there would change the user's folder) come back unchanged.
 */
export function withSetupStage(loop: LoopDefinition, testCommand: string | null): LoopDefinition {
  const command = setupCommandFor(testCommand);
  if (!command || isFactoryLoop(loop) || !runsInWorktree(loop.config, false)) return loop;
  const stages = [...loop.config.stages].sort((a, b) => a.order - b.order);
  if (stages.some(isSetupStage) || stages.some((s) => s.kind === "shellCommand" && s.command === command)) return loop;
  if (!stages.some((s) => s.enabled && s.kind === "shellCommand" && s.command === testCommand)) return loop;
  const setup = decodeStage({ id: `${SETUP_ID_PREFIX}${crypto.randomUUID()}`, name: "Set up", kind: "shellCommand", command, order: 0, enabled: true, severity: "blocking", runOnce: true, allowsRepair: false });
  if (!setup) return loop;
  return { ...loop, config: { ...loop.config, stages: [setup, ...stages].map((s, i) => ({ ...s, order: i })) } };
}

type ReadFs = Pick<FsApi, "read">;
const markerPath = (prefix: string, dir: string): string => `${prefix}/${dir}/.llmide-setup`;

async function lockHash(fs: ReadFs, prefix: string, lockfile: string): Promise<string | null> {
  try {
    const r = await fs.read(`${prefix}/${lockfile}`, 20_000_000);
    return r.status === "ok" ? r.hash : null;
  } catch { return null; }
}

/** True when the setup must run: no install marker in this worktree, or the lockfile is not the one last installed. */
export async function setupNeeded(fs: ReadFs, prefix: string, command: string): Promise<boolean> {
  const install = INSTALLS[command];
  if (!install) return true;
  try {
    const m = await fs.read(markerPath(prefix, install.dir), 1000);
    if (m.status !== "ok" || m.text === null) return true;
    return m.text.trim() !== `${await lockHash(fs, prefix, install.lockfile) ?? "no-lockfile"}`;
  } catch { return true; }
}

/** Records the lockfile the install just used, replacing an older marker. Best effort: a missed marker only repeats the install next run. */
export async function markSetupDone(fs: ReadFs & Pick<FsApi, "write">, prefix: string, command: string): Promise<void> {
  const install = INSTALLS[command];
  if (!install) return;
  const path = markerPath(prefix, install.dir);
  try {
    // A marker from an earlier install is overwritten against the hash just read; no marker is created from null.
    const current = await fs.read(path, 1000).then((r) => (r.status === "ok" ? r.hash : null), () => null);
    await fs.write(path, `${await lockHash(fs, prefix, install.lockfile) ?? "no-lockfile"}\n`, { expected_hash: current });
  } catch { /* repeated next run */ }
}

/** The run's stages: the Set up stage stays on only when `needed`; a run without a worktree never installs. */
export function configWithSetup<C extends { stages: readonly LoopStage[] }>(config: C, needed: boolean): C {
  return { ...config, stages: config.stages.map((s) => (isSetupStage(s) ? { ...s, enabled: needed } : s)) };
}
