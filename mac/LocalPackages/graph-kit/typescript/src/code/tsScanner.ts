// TypeScript / JavaScript code → graph, via the TypeScript compiler API (per-file
// AST, no full type-check Program — fast and dependency-light). Produces the same
// canonical CGData as the Swift code scanner: file/symbol nodes with
// contains/imports/inherits/implements edges.
//
// Deterministic: files and members are processed in sorted order, so the output is
// stable across runs (safe for the idempotent `update` pipeline).
//
// Not yet covered (parity gap with the Swift tree-sitter scanner): a call graph.
// Structural extraction (files, imports, declarations, inheritance) is implemented.

import ts from "typescript";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, extname, relative, resolve, dirname } from "node:path";
import type { CGData, CGEdge, CGNode, CGNodeKind } from "../models.js";
import { EXCLUDED_DIRS } from "../exclusions.js";
import { loadScipIndex, parseScipJson } from "./scipScanner.js";

const CODE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"]);
// Dotted dirs (.git, .graphkit) are covered by the walk's startsWith(".") check.
const SKIP_DIRS = EXCLUDED_DIRS;
const RESOLVE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"];

interface Heritage {
  symbolId: string;
  extendsNames: string[];
  implementsNames: string[];
}

/**
 * Scan `root` into a code graph. When `opts.scipIndex` is set, prefer the
 * higher-fidelity SCIP index (parsed via `parseScipJson`/`loadScipIndex`) over the
 * tree-sitter walk; otherwise fall back to the existing TypeScript-compiler-API scan.
 */
export async function scanCode(
  root: string,
  opts: { maxFiles?: number; maxFileBytes?: number; scipIndex?: string } = {},
): Promise<CGData> {
  if (opts.scipIndex) {
    const json = await loadScipIndex(opts.scipIndex);
    return parseScipJson(json);
  }

  const maxFiles = opts.maxFiles ?? 2000;
  const maxFileBytes = opts.maxFileBytes ?? 1_000_000;
  const rootAbs = resolve(root);

  const files = collectCodeFiles(rootAbs, maxFiles, maxFileBytes);
  const nodes: CGNode[] = [];
  const edges: CGEdge[] = [];
  const symbolIdsByName = new Map<string, string[]>(); // name → ids (for heritage resolution)
  const heritages: Heritage[] = [];
  const callSites: Array<{ fromId: string; name: string }> = [];
  const seenEdge = new Set<string>();

  const addEdge = (fromId: string, toId: string, kind: CGEdge["kind"], confidence: CGEdge["confidence"]) => {
    if (fromId === toId) return;
    const key = `${fromId}→${toId}:${kind}`;
    if (seenEdge.has(key)) return;
    seenEdge.add(key);
    edges.push({ fromId, toId, kind, confidence });
  };
  const addSymbolName = (name: string, id: string) => {
    (symbolIdsByName.get(name) ?? symbolIdsByName.set(name, []).get(name)!).push(id);
  };

  for (const file of files) {
    const rel = relative(rootAbs, file);
    const fileId = `file:${rel}`;
    const language = [".js", ".jsx", ".mjs", ".cjs"].includes(extname(file)) ? "javascript" : "typescript";
    nodes.push({ id: fileId, title: rel.split("/").pop() ?? rel, kind: "file", metadata: { path: rel, language } });

    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, /*setParentNodes*/ true);

    for (const stmt of sf.statements) {
      // imports → file → file (extracted)
      if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
        const target = resolveImport(file, stmt.moduleSpecifier.text, rootAbs);
        if (target) addEdge(fileId, `file:${target}`, "imports", "EXTRACTED");
        continue;
      }
      emitDeclaration(stmt, fileId, rel, nodes, addEdge, addSymbolName, heritages);
    }
    collectCalls(sf, rel, callSites);
  }

  // Resolve call sites against collected symbol names (name-based, no type info):
  // a unique name match → INFERRED; an ambiguous (multi-match) name → AMBIGUOUS.
  // Calls to names with no in-repo symbol (library/builtins) are dropped.
  for (const c of callSites) {
    const targets = symbolIdsByName.get(c.name);
    if (!targets || targets.length === 0) continue;
    const confidence = targets.length === 1 ? "INFERRED" : "AMBIGUOUS";
    for (const id of targets) addEdge(c.fromId, id, "calls", confidence);
  }

  // Resolve heritage names against collected symbol names (name-based → inferred).
  for (const h of heritages) {
    for (const name of h.extendsNames) {
      for (const id of symbolIdsByName.get(name) ?? []) addEdge(h.symbolId, id, "inherits", "INFERRED");
    }
    for (const name of h.implementsNames) {
      for (const id of symbolIdsByName.get(name) ?? []) addEdge(h.symbolId, id, "implements", "INFERRED");
    }
  }

  return { nodes, edges, layers: [], tour: [] };
}

function emitDeclaration(
  stmt: ts.Statement,
  fileId: string,
  rel: string,
  nodes: CGNode[],
  addEdge: (f: string, t: string, k: CGEdge["kind"], c: CGEdge["confidence"]) => void,
  addSymbolName: (name: string, id: string) => void,
  heritages: Heritage[],
): void {
  const addSymbol = (name: string, kind: CGNodeKind, symbolKind: string): string => {
    const id = `symbol:${rel}#${name}`;
    nodes.push({ id, title: name, kind, metadata: { path: rel, symbolKind } });
    addSymbolName(name, id);
    addEdge(fileId, id, "contains", "EXTRACTED");
    return id;
  };

  if (ts.isFunctionDeclaration(stmt) && stmt.name) {
    addSymbol(stmt.name.text, "function", "function");
  } else if (ts.isClassDeclaration(stmt) && stmt.name) {
    const classId = addSymbol(stmt.name.text, "classType", "class");
    const h: Heritage = { symbolId: classId, extendsNames: [], implementsNames: [] };
    for (const clause of stmt.heritageClauses ?? []) {
      const names = clause.types.map((t) => (ts.isIdentifier(t.expression) ? t.expression.text : "")).filter(Boolean);
      if (clause.token === ts.SyntaxKind.ExtendsKeyword) h.extendsNames.push(...names);
      else if (clause.token === ts.SyntaxKind.ImplementsKeyword) h.implementsNames.push(...names);
    }
    heritages.push(h);
    // Methods → symbols owned by the class.
    for (const member of stmt.members) {
      if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
        const mId = `symbol:${rel}#${stmt.name.text}.${member.name.text}`;
        nodes.push({ id: mId, title: `${stmt.name.text}.${member.name.text}`, kind: "symbol", metadata: { path: rel, symbolKind: "method" } });
        addEdge(classId, mId, "contains", "EXTRACTED");
      }
    }
  } else if (ts.isInterfaceDeclaration(stmt)) {
    const ifaceId = addSymbol(stmt.name.text, "symbol", "interface");
    const h: Heritage = { symbolId: ifaceId, extendsNames: [], implementsNames: [] };
    for (const clause of stmt.heritageClauses ?? []) {
      const names = clause.types.map((t) => (ts.isIdentifier(t.expression) ? t.expression.text : "")).filter(Boolean);
      if (clause.token === ts.SyntaxKind.ExtendsKeyword) h.extendsNames.push(...names);
    }
    heritages.push(h);
  } else if (ts.isVariableStatement(stmt)) {
    // `const f = () => {}` / `const f = function(){}` → function symbol.
    for (const decl of stmt.declarationList.declarations) {
      if (
        ts.isIdentifier(decl.name) &&
        decl.initializer &&
        (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
      ) {
        addSymbol(decl.name.text, "function", "function");
      }
    }
  }
}

/** The called name from a CallExpression target: `foo()`→"foo", `o.bar()`→"bar". */
function calleeName(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
}

/**
 * Walk a file collecting (enclosing-symbol-id, called-name) for every call inside a
 * function/method/arrow-const body. The enclosing id mirrors the ids emitDeclaration
 * assigns, so resolution can link symbol→symbol `calls` edges.
 */
function collectCalls(
  sf: ts.SourceFile,
  rel: string,
  out: Array<{ fromId: string; name: string }>,
): void {
  const visit = (node: ts.Node, enclosing: string | null): void => {
    let next = enclosing;
    if (ts.isFunctionDeclaration(node) && node.name) {
      next = `symbol:${rel}#${node.name.text}`;
    } else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
      const cls = ts.isClassDeclaration(node.parent) && node.parent.name ? node.parent.name.text : "";
      next = cls ? `symbol:${rel}#${cls}.${node.name.text}` : enclosing;
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      next = `symbol:${rel}#${node.name.text}`;
    }
    if (ts.isCallExpression(node) && enclosing) {
      const name = calleeName(node.expression);
      if (name) out.push({ fromId: enclosing, name });
    }
    ts.forEachChild(node, (child) => visit(child, next));
  };
  visit(sf, null);
}

/** Resolve a relative import specifier to a repo-relative file path, or null. */
function resolveImport(fromFile: string, spec: string, rootAbs: string): string | null {
  if (!spec.startsWith(".")) return null; // bare/package import — skip (intra-repo only)
  const base = resolve(dirname(fromFile), spec);
  const candidates = [
    base,
    ...RESOLVE_EXTS.map((e) => base + e),
    ...RESOLVE_EXTS.map((e) => join(base, "index" + e)),
  ];
  for (const c of candidates) {
    try {
      if (existsSync(c) && statSync(c).isFile()) {
        const rel = relative(rootAbs, c);
        if (!rel.startsWith("..")) return rel;
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

function collectCodeFiles(root: string, maxFiles: number, maxFileBytes: number): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (out.length >= maxFiles) return;
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      if (out.length >= maxFiles) return;
      if (name.startsWith(".") || SKIP_DIRS.has(name)) continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else if (st.isFile() && CODE_EXTS.has(extname(full)) && st.size <= maxFileBytes && !name.endsWith(".d.ts")) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out.sort();
}
