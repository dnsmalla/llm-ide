// Kill switches of the extensions catalog (plan section 12), read at call time
// so a test or an operator can flip them without a restart.
//
//   LLMIDE_EXT_ACTIVE_SET   default OFF. On: the SDK plugin delivery, the skill
//                           set, the skill library ('/' menu, load-skill) and the
//                           user MCP builder honour the catalog's per-item and
//                           per-member switches. Off: exact legacy behaviour.
//   LLMIDE_EXT_ADAPTER      default ON (the user's decision, plan section 14):
//                           a provider-adapter turn mounts the user's ACTIVE MCP
//                           servers automatically when provider tools are allowed
//                           and the model can use tools. `off` is the operator's
//                           kill switch.
//   LLMIDE_EXT_SHADOW       default ON (off under NODE_ENV=test unless set): compare the computed active set with what
//                           the legacy consumers loaded, counts only, once a day
//                           per user. `off` stops the compare.

//   LLMIDE_EXT_CATALOG      default ON: a user may install items from GitHub into
//                           the catalog. `off` refuses install; items
//                           already installed stay as they are.
//   LLMIDE_EXT_SCAN         default advisory: findings are recorded and shown, never
//                           blocking. `off` skips the scan.
//   LLMIDE_EXT_ALLOWED_SOURCES  comma list of `owner/repo` globs; unset = any GitHub repo
//                           the user pastes.

const ON = new Set(['1', 'on', 'true', 'yes']);
const OFF = new Set(['0', 'off', 'false', 'no']);
const read = (name) => String(process.env[name] ?? '').trim().toLowerCase();

export function activeSetEnabled() { return ON.has(read('LLMIDE_EXT_ACTIVE_SET')); }
export function adapterEnabled() { return !OFF.has(read('LLMIDE_EXT_ADAPTER')); }
// Under NODE_ENV=test the shadow stays off unless a test turns it on, so the
// engine's unit tests never compute an active set as a side effect.
export function shadowEnabled() {
  const v = read('LLMIDE_EXT_SHADOW');
  if (v === '') return process.env.NODE_ENV !== 'test';
  return !OFF.has(v);
}
export function catalogEnabled() { return !OFF.has(read('LLMIDE_EXT_CATALOG')); }
export function scanEnabled() { return read('LLMIDE_EXT_SCAN') !== 'off'; }
