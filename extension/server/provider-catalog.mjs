// The built-in provider catalog (server/provider-catalog.json) and the pure
// capability logic over it. No I/O besides reading the JSON once.
//
// Capability flag per model: `toolsSupported`, with `toolsSource` saying where
// it came from, so the UI can show "tools" confidently or as a guess:
//   'catalog'   the static table lists the model
//   'provider'  the provider's live list says so (OpenRouter supported_parameters)
//   'inferred'  the model id matches a family the catalog knows supports tools
//   'pattern'   the id matches `unverifiedToolPatterns`: a family third-party guides say supports tools, not
//               confirmed against the vendor's own docs; the UI shows "tools (assumed)"
//   'override'  the user set it (settings.toolOverrides)
//   'unknown'   nothing says so; treated as NOT supported (tool-heavy modes
//               refuse such a model instead of sending tools it may ignore)

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
let CATALOG = null;

function load() {
  if (CATALOG) return CATALOG;
  const raw = JSON.parse(fs.readFileSync(path.join(here, 'provider-catalog.json'), 'utf8'));
  CATALOG = new Map();
  for (const p of raw.providers) {
    CATALOG.set(p.id, Object.freeze({
      ...p,
      _tool: (p.toolPatterns || []).map((s) => new RegExp(s, 'i')),
      _utool: (p.unverifiedToolPatterns || []).map((s) => new RegExp(s, 'i')),
      _chat: (p.chatPatterns || ['.*']).map((s) => new RegExp(s, 'i')),
      _exclude: (p.excludePatterns || []).map((s) => new RegExp(s, 'i')),
    }));
  }
  return CATALOG;
}

/** Catalog entry by id, or undefined. */
export function catalogEntry(id) { return load().get(id); }

/** Every entry, in catalog order, without the compiled regexes. */
export function catalogEntries() {
  return [...load().values()].map(({ _tool, _utool, _chat, _exclude, ...pub }) => pub);
}

/** Whether a model id is a chat model for this entry (drops embeddings, tts, …). */
export function isChatModel(entry, id) {
  if (!entry || typeof id !== 'string' || !id) return false;
  if (entry._exclude.some((re) => re.test(id))) return false;
  return entry._chat.some((re) => re.test(id));
}

/**
 * The capability record for one model. `live` is whatever the provider's own
 * list said about it ({ toolsSupported?, contextWindow? }); `override` is the
 * user's explicit true/false from settings.
 */
export function modelCapability(entry, id, { live, override } = {}) {
  const stat = entry?.models?.find((m) => m.id === id);
  let toolsSupported = false;
  let toolsSource = 'unknown';
  if (typeof override === 'boolean') { toolsSupported = override; toolsSource = 'override'; }
  else if (typeof live?.toolsSupported === 'boolean') { toolsSupported = live.toolsSupported; toolsSource = 'provider'; }
  else if (stat && typeof stat.toolsSupported === 'boolean') { toolsSupported = stat.toolsSupported; toolsSource = 'catalog'; }
  else if (entry?._tool?.some((re) => re.test(id))) { toolsSupported = true; toolsSource = 'inferred'; }
  else if (entry?._utool?.some((re) => re.test(id))) { toolsSupported = true; toolsSource = 'pattern'; }
  const contextWindow = Number.isFinite(live?.contextWindow) ? live.contextWindow
    : (Number.isFinite(stat?.contextWindow) ? stat.contextWindow : null);
  return { id, toolsSupported, toolsSource, streaming: true, contextWindow };
}

/** Modes whose job needs tools. A model without them (or tools switched off) is NOT refused there: the turn runs as plain chat and says so. */
export const TOOL_MODES = Object.freeze(new Set(['execute', 'plan', 'assist_plan', 'review']));
