// Feature-owned route groups — the server half of LLMIDE_FEATURES.
//
// The Mac app can be built without some features (mac/Package.swift) and
// passes the enabled list to the server it spawns (core/config.mjs →
// config.features). A group listed here is imported ONLY when its feature is
// enabled: a disabled feature's code is neither loaded at boot nor reachable,
// and its paths answer 404 { error: 'feature_disabled', feature } so a client
// that still calls one fails loudly instead of reading a generic unknown-route
// 404 ("restart the server?").
//
// A group belongs here only when EVERY caller of its paths is the feature it
// names (or Mac code that feature's build exclusion removes). Routes with a
// caller outside the feature stay always-on in router.mjs / server.mjs:
//   - doc_gen → /generate-doc only (routes/doc-gen.mjs). /generate-docx stays
//     always-on (server/export-routes.mjs): the Chrome extension's ExportMenu
//     calls it and lists it in REQUIRED_ENDPOINTS.
//   - planning / review / agent / agent-v2 / chat / live serve Chat, which
//     cannot be excluded.
//
// Adding a feature-owned route: put it in its own route module exporting
// `handle…Routes(req, res, ctx) → Promise<boolean>`, add the group below, and
// call `featureHandlers.<key>?.(…)` at its dispatch position in router.mjs.

import { sendJSON } from '../core/utils.mjs';

export const FEATURE_ROUTE_GROUPS = Object.freeze({
  // Mac 3D code graph upload (Features/CodeGraph/Services/CodeGraphUploadService).
  // graphkit itself stays loaded: agents/planner reads the graph for grounding.
  code_graph_3d: Object.freeze({
    prefixes: Object.freeze(['/kb/ingest-code-graph']),
    load: async () => (await import('./code-graph.mjs')).handleCodeGraphRoutes,
  }),
  // Gantt schedule overlay (Features/Issues, incl. Issues/Gantt, only).
  gantt_issues: Object.freeze({
    prefixes: Object.freeze(['/kb/issue-schedule']),
    load: async () => (await import('./issue-schedule.mjs')).handleIssueScheduleRoutes,
  }),
  // Doc Gen's /generate-doc (Features/Generation, Mac only). Prefix-matched
  // exactly: /generate-docx is a different, always-on route.
  doc_gen: Object.freeze({
    prefixes: Object.freeze(['/generate-doc']),
    load: async () => (await import('./doc-gen.mjs')).handleDocGenRoutes,
  }),
  // Loop / Auto-Tasks / Self-Heal headless agent step (Features/Loop +
  // Features/AutoTask). The largest group: llm_agent/sdk/loop-agent.mjs.
  auto_tasks: Object.freeze({
    prefixes: Object.freeze(['/kb/loop/']),
    load: async () => (await import('./loop-agent.mjs')).handleLoopAgentRoutes,
  }),
});

const loaded = new Set();

/** Feature keys whose route modules this process has imported (test seam). */
export function loadedGroups() {
  return [...loaded];
}

function isEnabled(features, key) {
  return features == null || features.has(key);
}

/**
 * The disabled feature that owns `pathname`, or null when the path is served.
 *
 * @param {string} pathname request URL (a query string is ignored)
 * @param {ReadonlySet<string>|null} features enabled keys; null = all
 * @returns {string|null}
 */
export function featureDisabledFor(pathname, features) {
  if (features == null) return null;
  for (const [key, group] of Object.entries(FEATURE_ROUTE_GROUPS)) {
    if (features.has(key)) continue;
    if (group.prefixes.some((prefix) => routePathMatches(pathname, prefix))) return key;
  }
  return null;
}

/**
 * Whether `pathname` (query string ignored) is served by `prefix`. A prefix
 * ending in '/' matches anything under it; any other prefix matches itself and
 * its sub-paths only, so '/generate-doc' does not match '/generate-docx'.
 *
 * @param {string} pathname request URL
 * @param {string} prefix a FEATURE_ROUTE_GROUPS prefix
 * @returns {boolean}
 */
export function routePathMatches(pathname, prefix) {
  const path = String(pathname || '').split('?')[0];
  if (prefix.endsWith('/')) return path.startsWith(prefix);
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * Import the enabled groups' route modules. Called once at boot (server.mjs,
 * via router.mjs#initFeatureRoutes) so a broken module still fails the boot
 * the way a static import did, not the first request.
 *
 * @param {ReadonlySet<string>|null} features enabled keys; null = all
 * @returns {Promise<{ handlers: Record<string, Function>, disabledPrefixes: string[] }>}
 */
export async function loadFeatureRoutes(features) {
  const entries = Object.entries(FEATURE_ROUTE_GROUPS);
  const enabled = entries.filter(([key]) => isEnabled(features, key));
  const resolved = await Promise.all(enabled.map(async ([key, group]) => [key, await group.load()]));
  for (const [key] of resolved) loaded.add(key);
  const disabledPrefixes = entries
    .filter(([key]) => !isEnabled(features, key))
    .flatMap(([, group]) => group.prefixes);
  return Object.freeze({
    handlers: Object.freeze(Object.fromEntries(resolved)),
    disabledPrefixes: Object.freeze(disabledPrefixes),
  });
}

/** `endpoints` minus the paths a disabled feature owns (for /health ENDPOINTS). */
export function enabledEndpoints(endpoints, features) {
  return endpoints.filter((endpoint) => featureDisabledFor(endpoint, features) == null);
}

/** The fixed wire answer for a disabled feature's path (contract with the Mac). */
export function sendFeatureDisabled(res, feature) {
  sendJSON(res, 404, { error: 'feature_disabled', feature });
}
