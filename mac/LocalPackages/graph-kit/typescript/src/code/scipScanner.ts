import { spawn } from "node:child_process";
import type { CGData, CGNode, CGNodeKind, CGEdge, CGEdgeKind } from "../models.js";

/** Read a foreign-JSON field tolerating snake_case or camelCase. */
function field<T = unknown>(o: Record<string, unknown> | undefined, snake: string, camel: string): T | undefined {
  if (!o) return undefined;
  if (o[snake] !== undefined) return o[snake] as T;
  return o[camel] as T | undefined;
}

// SCIP proto `SymbolInformation.Kind` values actually used here. `scip print --json`
// may serialize the enum as its numeric value or as its string name depending on the
// JSON serialization used, so accept both — see `kindFromScip`.
const SCIP_KIND_NAME_TO_NUMBER: Record<string, number> = {
  Class: 7,
  Constructor: 9,
  Interface: 21,
  Function: 17,
  Method: 26,
  Module: 29,
  Namespace: 30,
  Package: 35,
};

/** SCIP SymbolKind (subset) → canonical node kind. Accepts the numeric enum value or
 * its string name (some `scip print --json` serializations emit the name instead). */
function kindFromScip(kind: number | string | undefined): CGNodeKind {
  const numeric = typeof kind === "string" ? SCIP_KIND_NAME_TO_NUMBER[kind] : kind;
  switch (numeric) {
    case 7: return "classType";  // Class
    case 9: return "classType";  // Constructor
    case 21: return "classType"; // Interface — type-like; `implements` edges target these too
    case 17: return "function";  // Function
    case 26: return "function";  // Method
    case 29: return "module";    // Module
    case 30: return "module";    // Namespace
    case 35: return "module";    // Package
    default: return "symbol";
  }
}

/**
 * Normalize a raw SCIP range array into {startLine,endLine}, or `undefined` when the
 * range can't be parsed. Real SCIP ranges come in exactly two shapes:
 *  - 4 elements `[startLine, startChar, endLine, endChar]` for multi-line spans.
 *  - 3 elements `[line, startChar, endChar]` for single-line spans (the line is
 *    implied to be the same for start and end) — this is what real indexers emit for
 *    most identifier occurrences, which are always single-line.
 * There is no third shape (no `single_line_range`/`multi_line_range` fields exist in
 * SCIP) — anything else means "no range known", and callers must not default that to
 * line 0, since that would make an unparseable range spuriously contain everything at
 * line 0.
 */
function linesFromRangeArray(arr: unknown): { startLine: number; endLine: number } | undefined {
  if (!Array.isArray(arr)) return undefined;
  if (arr.length === 4 && typeof arr[0] === "number" && typeof arr[2] === "number") {
    return { startLine: arr[0], endLine: arr[2] };
  }
  if (arr.length === 3 && typeof arr[0] === "number") {
    return { startLine: arr[0], endLine: arr[0] };
  }
  return undefined;
}

/** Read `snakeField`/`camelField` (default `range`/`range`) off an occurrence-shaped
 * object and normalize it via `linesFromRangeArray`. Used both for an occurrence's own
 * `range` (identifier span, → `metadata.line`) and for a definition occurrence's
 * `enclosing_range`/`enclosingRange` (declaration body, → containment matching). */
function occLines(
  occ: Record<string, unknown>,
  snakeField = "range",
  camelField = snakeField,
): { startLine: number; endLine: number } | undefined {
  return linesFromRangeArray(field<number[]>(occ, snakeField, camelField));
}

export function parseScipJson(index: unknown): CGData {
  const idx = index as Record<string, unknown>;
  const documents = (field<unknown[]>(idx, "documents", "documents") ?? []) as Record<string, unknown>[];
  const nodes: CGNode[] = [];
  const edges: CGEdge[] = [];
  const seenDef = new Set<string>();
  const seenEdge = new Set<string>();

  const addEdge = (fromId: string, toId: string, kind: CGEdgeKind) => {
    const key = `${fromId}${toId}${kind}`;
    if (fromId === toId || seenEdge.has(key)) return;
    seenEdge.add(key);
    edges.push({ fromId, toId, kind, confidence: "EXTRACTED" });
  };

  for (const doc of documents) {
    const sourceFile = field<string>(doc, "relative_path", "relativePath") ?? "";
    const language = field<string>(doc, "language", "language") ?? "";
    const symbols = (field<unknown[]>(doc, "symbols", "symbols") ?? []) as Record<string, unknown>[];
    const occurrences = (field<unknown[]>(doc, "occurrences", "occurrences") ?? []) as Record<string, unknown>[];

    // Definition occurrence (role bit 0x1) per symbol id, built once per document — used
    // for both node provenance (`range`) and containment (`enclosing_range`) below.
    const defOccBySymbol = new Map<string, Record<string, unknown>>();
    for (const o of occurrences) {
      const roles = field<number>(o, "symbol_roles", "symbolRoles") ?? 0;
      if ((roles & 0x1) === 0) continue;
      const sid = field<string>(o, "symbol", "symbol");
      if (sid && !defOccBySymbol.has(sid)) defOccBySymbol.set(sid, o);
    }

    // Enclosing range per symbol id, from `enclosing_range`/`enclosingRange` on the
    // definition occurrence — "the range of the enclosing declaration including its
    // body" (present on function/class/method/interface/enum/constructor definitions).
    // A symbol with no parseable enclosing range is deliberately left `undefined` here
    // (never defaulted to {0,0}) so it's excluded as a containment candidate entirely,
    // rather than spuriously matching every occurrence at line 0.
    const enclosingLinesBySymbol = new Map<string, { startLine: number; endLine: number } | undefined>();
    for (const [sid, defOcc] of defOccBySymbol) {
      enclosingLinesBySymbol.set(sid, occLines(defOcc, "enclosing_range", "enclosingRange"));
    }

    // Definition nodes (as in Task 1) …
    for (const sym of symbols) {
      const symbolId = field<string>(sym, "symbol", "symbol") ?? "";
      const displayName = field<string>(sym, "display_name", "displayName");
      const kind = field<number | string>(sym, "kind", "kind");
      const documentation = field<string[]>(sym, "documentation", "documentation");

      const def = defOccBySymbol.get(symbolId);
      const lines = def ? occLines(def) : undefined;
      if (!seenDef.has(symbolId)) {
        seenDef.add(symbolId);
        nodes.push({
          id: symbolId,
          title: displayName ?? symbolId.split(" ").pop() ?? symbolId,
          kind: kindFromScip(kind),
          metadata: {
            source_file: sourceFile,
            fileURL: `file://${sourceFile}`,
            line: `L${lines?.startLine ?? 0}`,
            language,
            ...(documentation?.length ? { doc: documentation.join("\n") } : {}),
            extracted_by: "scip",
          },
        });
      }

      // Relationship edges (implements / references)
      const relationships = field<unknown[]>(sym, "relationships", "relationships") ?? [];
      for (const rel of relationships) {
        const r = rel as Record<string, unknown>;
        const relKind: CGEdgeKind = field<boolean>(r, "is_implementation", "isImplementation")
          ? "implements"
          : "references";
        const relTarget = field<string>(r, "symbol", "symbol") ?? "";
        if (relTarget) {
          addEdge(symbolId, relTarget, relKind);
        }
      }
    }

    // Reference edges: each non-definition occurrence → innermost enclosing definition.
    for (const occ of occurrences) {
      const roles = field<number>(occ, "symbol_roles", "symbolRoles") ?? 0;
      if ((roles & 0x1) !== 0) continue; // skip definitions
      const target = field<string>(occ, "symbol", "symbol");
      if (!target) continue;
      const occRange = occLines(occ);
      if (!occRange) continue; // no parseable range on this occurrence — can't test containment

      // Among all symbols whose enclosing range legitimately contains this occurrence,
      // pick the innermost one — the candidate with the largest startLine (i.e. the
      // tightest/latest-starting enclosing scope) — so references inside nested
      // functions/methods attribute to the nearest enclosing scope, not an outer one.
      let enclosingId: string | undefined;
      let bestStart = -Infinity;
      for (const s of symbols) {
        const sid = field<string>(s, "symbol", "symbol");
        if (!sid || sid === target) continue;
        const enc = enclosingLinesBySymbol.get(sid);
        if (!enc) continue;
        if (occRange.startLine >= enc.startLine && occRange.startLine <= enc.endLine && enc.startLine > bestStart) {
          bestStart = enc.startLine;
          enclosingId = sid;
        }
      }
      if (!enclosingId) continue;
      const edgeKind: CGEdgeKind = (roles & 0x2) !== 0 ? "imports" : "references";
      addEdge(enclosingId, target, edgeKind);
    }
  }

  return { nodes, edges, layers: [], tour: [] };
}

export function loadScipIndex(scipPath: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn("scip", ["print", "--json", scipPath], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let settled = false;

    const settle = (fn: () => void) => {
      if (!settled) {
        settled = true;
        fn();
      }
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => { out += c; });
    child.stderr.on("data", (c: string) => { err += c; });
    child.on("error", (e) => settle(() => reject(new Error(`scip CLI not available: ${e.message}`))));
    child.on("close", (code) => {
      settle(() => {
        if (code !== 0) return reject(new Error(`scip print exited ${code}: ${err}`));
        try { resolve(JSON.parse(out)); }
        catch (e) { reject(new Error(`scip print emitted invalid JSON: ${(e as Error).message}`)); }
      });
    });
  });
}
