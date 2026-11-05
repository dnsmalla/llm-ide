// Chrome extension origin pin (ROADMAP Q22). `<dataDir>/extension-ids.json` = {"ids": ["<32 chars a-p>", ...]}
// pins CORS to those extension IDs. No file (or no data dir) = unpinned: any chrome-extension:// origin, as before.
// A file that exists but cannot be used pins to NOTHING (fail closed), never back to "any".
import fs from 'node:fs';
import path from 'node:path';

export const EXTENSION_IDS_FILE = 'extension-ids.json';
const CHROME_EXT = 'chrome-extension://';
const ID_RE = /^[a-p]{32}$/;

/** null = unpinned; otherwise the allowed IDs (possibly empty). Read once at boot. */
export function loadPinnedExtensionIds(dataDir, log = console.error) {
  if (!dataDir) return null;
  const file = path.join(dataDir, EXTENSION_IDS_FILE);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e?.code === 'ENOENT') return null;
    log(`extension origin pin: cannot read ${file} (${e?.code ?? e}); refusing every chrome-extension origin`);
    return [];
  }
  try {
    const ids = JSON.parse(text)?.ids;
    if (!Array.isArray(ids)) throw new Error('"ids" must be an array');
    const bad = ids.filter((id) => typeof id !== 'string' || !ID_RE.test(id));
    if (bad.length) throw new Error(`not an extension ID: ${bad.map(String).join(', ')}`);
    return ids;
  } catch (e) {
    log(`extension origin pin: ${file} is invalid (${e.message}); refusing every chrome-extension origin`);
    return [];
  }
}

/** True for a chrome-extension origin the pin allows (exact `chrome-extension://<id>`, no path). */
export function extensionOriginAllowed(origin, pinnedIds) {
  if (typeof origin !== 'string' || !origin.startsWith(CHROME_EXT)) return false;
  if (pinnedIds === null) return true;
  return pinnedIds.includes(origin.slice(CHROME_EXT.length));
}
