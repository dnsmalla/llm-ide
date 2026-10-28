// Refuses to boot on the repo kb after its data was moved to the app data dir.
//
// After a move, <repo>/kb/MOVED-TO-APP-SUPPORT.txt exists and kb/data.db does
// not. Any process that opens the legacy path (npm run server, an older build, a
// dev server that the app adopts) would then create an empty DB and fresh
// secrets there, and split the data silently. The server stops instead, with a
// message saying what to do. LLMIDE_ALLOW_EMPTY_LEGACY=1 overrides it.
import fs from 'fs';
import path from 'path';

export const MOVED_NOTICE = 'MOVED-TO-APP-SUPPORT.txt';

/**
 * @returns {null | {refuse: boolean, message: string}} null when there is nothing to say
 */
export function legacyTripwire({ root, env = process.env }) {
  const legacyDir = path.join(root, 'kb');
  if (!fs.existsSync(path.join(legacyDir, MOVED_NOTICE))) return null;
  if (fs.existsSync(path.join(legacyDir, 'data.db'))) return null;
  if (env.LLMIDE_ALLOW_EMPTY_LEGACY === '1') {
    return {
      refuse: false,
      message: `kb/data.db was moved to the app data directory; LLMIDE_ALLOW_EMPTY_LEGACY=1 lets this server create an empty database in ${legacyDir}`,
    };
  }
  return {
    refuse: true,
    message: [
      `Refusing to start: the data in ${legacyDir} was moved to the app data directory`,
      `(see ${path.join(legacyDir, MOVED_NOTICE)}). Starting here would create an empty`,
      'database and new secrets in the old location, and the two would silently diverge.',
      'Run the server with LLMIDE_DATA_DIR=<dir> (the Mac app does this), or restore',
      'kb/data.db from kb/data.db.pre-move or a backup if you want the old layout.',
      'To start anyway, set LLMIDE_ALLOW_EMPTY_LEGACY=1.',
    ].join(' '),
  };
}
