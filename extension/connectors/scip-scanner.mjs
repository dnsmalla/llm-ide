// Vendored port of graph-kit's typescript/src/code/scipScanner.ts (graph-kit main,
// unreleased past 1.6.0). Turns a Sourcegraph SCIP index into graph-kit's canonical
// CGData { nodes, edges }. Self-contained (node:child_process only) so the extension
// needs no npm dependency on the unpublished @dnsmalla/graph-kit package. When graph-kit
// TS is published, swap this for an `import` behind the connector in scip.mjs.

import { spawn } from 'node:child_process';

/** Read a foreign-JSON field tolerating snake_case or camelCase. */
function field(o, snake, camel) {
  if (!o) return undefined;
  if (o[snake] !== undefined) return o[snake];
  return o[camel];
}

// SCIP `SymbolInformation.Kind` values used here. `scip print --json` may emit the
// numeric value or the string name — kindFromScip accepts both.
const SCIP_KIND_NAME_TO_NUMBER = {
  Class: 7, Constructor: 9, Interface: 21, Function: 17, Method: 26,
  Module: 29, Namespace: 30, Package: 35,
};

function kindFromScip(kind) {
  const numeric = typeof kind === 'string' ? SCIP_KIND_NAME_TO_NUMBER[kind] : kind;
  switch (numeric) {
    case 7: return 'classType';   // Class
    case 9: return 'classType';   // Constructor
    case 21: return 'classType';  // Interface
    case 17: return 'function';   // Function
    case 26: return 'function';   // Method
    case 29: return 'module';     // Module
    case 30: return 'module';     // Namespace
    case 35: return 'module';     // Package
    default: return 'symbol';
  }
}

/** Normalize a SCIP range array. 4-el [sL,sC,eL,eC] or 3-el [L,sC,eC]; else undefined. */
function linesFromRangeArray(arr) {
  if (!Array.isArray(arr)) return undefined;
  if (arr.length === 4 && typeof arr[0] === 'number' && typeof arr[2] === 'number') {
    return { startLine: arr[0], endLine: arr[2] };
  }
  if (arr.length === 3 && typeof arr[0] === 'number') {
    return { startLine: arr[0], endLine: arr[0] };
  }
  return undefined;
}

function occLines(occ, snakeField = 'range', camelField = snakeField) {
  return linesFromRangeArray(field(occ, snakeField, camelField));
}

export function parseScipJson(index) {
  const idx = index || {};
  const documents = field(idx, 'documents', 'documents') || [];
  const nodes = [];
  const edges = [];
  const seenDef = new Set();
  const seenEdge = new Set();

  const addEdge = (fromId, toId, kind) => {
    const key = `${fromId}${toId}${kind}`;
    if (fromId === toId || seenEdge.has(key)) return;
    seenEdge.add(key);
    edges.push({ fromId, toId, kind, confidence: 'EXTRACTED' });
  };

  for (const doc of documents) {
    const sourceFile = field(doc, 'relative_path', 'relativePath') || '';
    const language = field(doc, 'language', 'language') || '';
    const symbols = field(doc, 'symbols', 'symbols') || [];
    const occurrences = field(doc, 'occurrences', 'occurrences') || [];

    const defOccBySymbol = new Map();
    for (const o of occurrences) {
      const roles = field(o, 'symbol_roles', 'symbolRoles') || 0;
      if ((roles & 0x1) === 0) continue;
      const sid = field(o, 'symbol', 'symbol');
      if (sid && !defOccBySymbol.has(sid)) defOccBySymbol.set(sid, o);
    }

    const enclosingLinesBySymbol = new Map();
    for (const [sid, defOcc] of defOccBySymbol) {
      enclosingLinesBySymbol.set(sid, occLines(defOcc, 'enclosing_range', 'enclosingRange'));
    }

    for (const sym of symbols) {
      const symbolId = field(sym, 'symbol', 'symbol') || '';
      const displayName = field(sym, 'display_name', 'displayName');
      const kind = field(sym, 'kind', 'kind');
      const documentation = field(sym, 'documentation', 'documentation');

      const def = defOccBySymbol.get(symbolId);
      const lines = def ? occLines(def) : undefined;
      if (!seenDef.has(symbolId)) {
        seenDef.add(symbolId);
        nodes.push({
          id: symbolId,
          title: displayName || (symbolId.split(' ').pop() || symbolId),
          kind: kindFromScip(kind),
          metadata: {
            source_file: sourceFile,
            fileURL: `file://${sourceFile}`,
            line: `L${lines ? lines.startLine : 0}`,
            language,
            ...(documentation && documentation.length ? { doc: documentation.join('\n') } : {}),
            extracted_by: 'scip',
          },
        });
      }

      const relationships = field(sym, 'relationships', 'relationships') || [];
      for (const rel of relationships) {
        const relKind = field(rel, 'is_implementation', 'isImplementation') ? 'implements' : 'references';
        const relTarget = field(rel, 'symbol', 'symbol') || '';
        if (relTarget) addEdge(symbolId, relTarget, relKind);
      }
    }

    for (const occ of occurrences) {
      const roles = field(occ, 'symbol_roles', 'symbolRoles') || 0;
      if ((roles & 0x1) !== 0) continue; // skip definitions
      const target = field(occ, 'symbol', 'symbol');
      if (!target) continue;
      const occRange = occLines(occ);
      if (!occRange) continue;

      let enclosingId;
      let bestStart = -Infinity;
      for (const s of symbols) {
        const sid = field(s, 'symbol', 'symbol');
        if (!sid || sid === target) continue;
        const enc = enclosingLinesBySymbol.get(sid);
        if (!enc) continue;
        if (occRange.startLine >= enc.startLine && occRange.startLine <= enc.endLine && enc.startLine > bestStart) {
          bestStart = enc.startLine;
          enclosingId = sid;
        }
      }
      if (!enclosingId) continue;
      const edgeKind = (roles & 0x2) !== 0 ? 'imports' : 'references';
      addEdge(enclosingId, target, edgeKind);
    }
  }

  return { nodes, edges, layers: [], tour: [] };
}

export function loadScipIndex(scipPath) {
  return new Promise((resolve, reject) => {
    const child = spawn('scip', ['print', '--json', scipPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let settled = false;
    // Kill the subprocess if it runs past 120s so a wedged `scip` CLI can't
    // hold the route indefinitely (route-timeout maps /kb/ingest-scip to 120s).
    const timer = setTimeout(() => child.kill('SIGTERM'), 120_000);
    if (typeof timer.unref === 'function') timer.unref();
    const settle = (fn) => { if (!settled) { settled = true; clearTimeout(timer); fn(); } };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', (e) => settle(() => reject(new Error(`scip CLI not available: ${e.message}`))));
    child.on('close', (code) => {
      settle(() => {
        if (code !== 0) return reject(new Error(`scip print exited ${code}: ${err}`));
        try { resolve(JSON.parse(out)); }
        catch (e) { reject(new Error(`scip print emitted invalid JSON: ${e.message}`)); }
      });
    });
  });
}
