// desktop/scripts/hub-out.mjs
// Where stage-hub-core.mjs writes the hub bundle when no --out is given.
// NOTE: Not desktop/dist: that is Vite's output folder, and every web build empties it, which deleted a
// staged bundle in a regression run. The choice lives here so a test can pin it without a staging download.
import { join, resolve } from 'node:path';

export const HUB_OUT_FOLDER = 'hub-dist';

/**
 * Resolves the output folder from the argv, mirroring the script's `arg()` reader.
 *
 * @param {string[]} args Command-line arguments after the script path.
 * @param {string} desktopDir Absolute path of the desktop folder.
 * @returns {string} The `--out` value when one is given, else `<desktopDir>/hub-dist`.
 */
export function resolveHubOut(args, desktopDir) {
  const index = args.indexOf('--out');
  const value = index >= 0 ? args[index + 1] : undefined;
  if (value && !value.startsWith('-')) return resolve(value);
  return join(desktopDir, HUB_OUT_FOLDER);
}
