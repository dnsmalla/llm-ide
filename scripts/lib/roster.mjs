// ALL_ENDPOINTS roster parser, shared by scripts/http-inventory.mjs and
// scripts/conformance-http.mjs so the roster is read in exactly one way.
//
// Parses the array from source text: the server is never imported, because
// importing extension/server.mjs boots it.

/** 1-based line number of `index` in `text`. */
export function lineOf(text, index) {
  let n = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/**
 * Every `'/path'` literal inside `const ALL_ENDPOINTS = [ … ];`.
 *
 * @param {string} src        text of the file that declares the roster
 * @param {string} sourceRel  repo-relative path, used only in the error message
 * @returns {{ path: string, line: number }[]} in source order, duplicates kept
 */
export function parseRoster(src, sourceRel = 'extension/server.mjs') {
  const m = /const ALL_ENDPOINTS = \[([\s\S]*?)\];/.exec(src);
  if (!m) throw new Error(`ALL_ENDPOINTS array not found in ${sourceRel}`);
  const base = m.index + m[0].indexOf('[') + 1;
  return [...m[1].matchAll(/'(\/[^']*)'/g)].map((x) => ({
    path: x[1],
    line: lineOf(src, base + x.index),
  }));
}

// ---------------------------------------------------------------- public + auth roster
//
// A second roster, kept apart from ALL_ENDPOINTS because it is not advertised by
// /health: the routes served before the KB router (`/`, `/health`, `/launch-app`,
// the auth namespace). It is read from the definitions that route them:
//   - PUBLIC_PATHS / PUBLIC_PREFIXES in extension/server/auth.mjs (no token needed)
//   - every literal dispatch in extension/server/auth-routes.mjs handleAuth() and
//     extension/routes/extension-routes.mjs handleExtensionRoute() (plugins, LLM sources, MCP plugins):
//     `url === '…'`, `url.split('?')[0] === '…'`, `path === '…'`, `url.startsWith('…')`
// Prefix dispatch names no parameter, so each prefix maps to its real routes in
// AUTH_PREFIX_TEMPLATES. The parser checks that table against the source in both
// directions: a prefix the source dispatches on with no template fails, and so does
// a template whose prefix the source no longer has.

export const AUTH_PREFIX_TEMPLATES = Object.freeze({
  '/auth/me/plugins/uninstall/': ['/auth/me/plugins/uninstall/:name'],
  '/auth/me/llm-sources/': ['/auth/me/llm-sources/:id', '/auth/me/llm-sources/:id/discovery'],
  '/auth/me/mcp-plugins/': ['/auth/me/mcp-plugins/:id', '/auth/me/mcp-plugins/:id/update', '/auth/me/mcp-plugins/:id/resync'],
  '/auth/me/connectors/': ['/auth/me/connectors/:id'],
});

/**
 * The public + auth roster.
 *
 * The /auth/* namespace is dispatched from more than one module (server/auth-routes.mjs
 * and, since Track Q, routes/extension-routes.mjs); `authSources` lists them in
 * dispatch order, each as `{ src, rel }`. The single-source form (`authSrc`/`authRel`)
 * still works.
 *
 * @param {{ publicSrc: string, authSrc?: string, authSources?: {src: string, rel: string}[], publicRel?: string, authRel?: string }} src
 * @returns {{ path: string, line: number, file: string }[]} deduplicated, in source order
 */
export function parsePublicAuthRoster({
  publicSrc, authSrc, authSources,
  publicRel = 'extension/server/auth.mjs',
  authRel = 'extension/server/auth-routes.mjs',
}) {
  const sources = authSources ?? [{ src: authSrc, rel: authRel }];
  const out = new Map();
  const add = (path, line, file) => { if (!out.has(path)) out.set(path, { path, line, file }); };

  const set = /const PUBLIC_PATHS = new Set\(\[([\s\S]*?)\]\);/.exec(publicSrc);
  if (!set) throw new Error(`PUBLIC_PATHS not found in ${publicRel}`);
  const base = set.index + set[0].indexOf('[') + 1;
  for (const m of set[1].matchAll(/'(\/[^']*)'/g)) add(m[1], lineOf(publicSrc, base + m.index), publicRel);

  const seen = new Set();
  for (const { src, rel } of sources) {
    const exact = [...src.matchAll(/\b(?:url(?:\.split\('\?'\)\[0\])?|path)\s*===\s*'(\/[^']*)'/g)];
    for (const m of exact) add(m[1], lineOf(src, m.index), rel);
    for (const m of src.matchAll(/\b(?:url(?:\.split\('\?'\)\[0\])?|path)\.startsWith\('(\/[^']*)'\)/g)) seen.add(m[1]);
  }
  for (const p of Object.keys(AUTH_PREFIX_TEMPLATES)) {
    if (!seen.has(p)) throw new Error(`AUTH_PREFIX_TEMPLATES has ${p} but ${sources.map((x) => x.rel).join(' / ')} no longer dispatches on it`);
  }
  for (const { src, rel } of sources) {
    for (const m of src.matchAll(/\b(?:url(?:\.split\('\?'\)\[0\])?|path)\.startsWith\('(\/[^']*)'\)/g)) {
      const templates = AUTH_PREFIX_TEMPLATES[m[1]];
      if (!templates) throw new Error(`${rel}:${lineOf(src, m.index)} dispatches on prefix ${m[1]} with no entry in AUTH_PREFIX_TEMPLATES`);
      for (const t of templates) add(t, lineOf(src, m.index), rel);
    }
  }
  return [...out.values()];
}

/**
 * Both rosters, read through `readText(relPath)` so each script reads files its own way.
 *
 * @param {(rel: string) => string} readText
 * @returns {{ endpoints: {path:string,line:number}[], publicAuth: {path:string,line:number,file:string}[] }}
 */
export function loadRosters(readText) {
  const serverRel = 'extension/server.mjs';
  return {
    endpoints: parseRoster(readText(serverRel), serverRel),
    publicAuth: parsePublicAuthRoster({
      publicSrc: readText('extension/server/auth.mjs'),
      authSources: [
        { src: readText('extension/server/auth-routes.mjs'), rel: 'extension/server/auth-routes.mjs' },
        { src: readText('extension/routes/extension-routes.mjs'), rel: 'extension/routes/extension-routes.mjs' },
        { src: readText('extension/routes/extensions-catalog.mjs'), rel: 'extension/routes/extensions-catalog.mjs' },
      ],
    }),
  };
}
