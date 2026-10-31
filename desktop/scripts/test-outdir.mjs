// Per-process, collision-free bundle directory for screen tests. Test files run as parallel node processes
// (and several `npm test` runs may overlap), so a fixed outfile lets one process overwrite another's bundle
// mid-import. The directory lives under desktop/node_modules/.cache so bundled `react` etc. still resolve to
// desktop's single copy; it is unique per process and removed on exit.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const made = new Map();

export function bundleDir(label) {
  let dir = made.get(label);
  if (dir) return dir;
  const parent = join(DESKTOP, "node_modules/.cache", `${label}-test`);
  mkdirSync(parent, { recursive: true });
  dir = mkdtempSync(join(parent, `p${process.pid}-`));
  made.set(label, dir);
  process.on("exit", () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
  return dir;
}
