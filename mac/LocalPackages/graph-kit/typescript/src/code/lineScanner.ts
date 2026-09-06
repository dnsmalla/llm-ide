// Line-based structure extraction for languages the TypeScript compiler API
// cannot parse: Swift, Kotlin and Python.
//
// Port of the language cases in Swift `GraphKit.FileStructureExtractor`, which
// reads every file line by line rather than building an AST. Without this the
// plugin returned **0 nodes** for a Swift, Kotlin or Python tree — the graph
// simply did not see them.
//
// Deliberately NOT byte-parity with the Swift engine, and the code track is not
// gated for equality the way the doc track is:
//
//   * TypeScript/JavaScript go through the TypeScript compiler API here
//     (`tsScanner`), which yields call and inheritance edges the Swift engine's
//     line reader cannot produce. Richer, by design.
//   * Python goes through a real AST in the Swift engine (a `python3`
//     subprocess); here it is line-based, so nested and conditionally-defined
//     symbols are missed. Poorer, by necessity — a Node plugin cannot assume a
//     Python toolchain.
//
// What IS guaranteed is the shape: file nodes carry `source_file`, symbol nodes
// hang off their file by `contains`, and imports become `imports` edges — so a
// graph from either engine merges and renders identically.

import { readFileSync } from "node:fs";
import { extname } from "node:path";

/** Extension → language, for the languages this scanner owns. */
const LANGUAGE_BY_EXT: Record<string, string> = {
  ".swift": "swift",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".py": "python",
};

export const LINE_SCANNED_EXTS = new Set(Object.keys(LANGUAGE_BY_EXT));

export function lineScannedLanguage(path: string): string | null {
  return LANGUAGE_BY_EXT[extname(path).toLowerCase()] ?? null;
}

export interface LineSymbol {
  name: string;
  /** Language-level kind (`function`, `class`, `struct`, …) — carried as
   *  `symbolKind` metadata, mirroring the Swift engine. */
  kind: string;
  line: number;
  declaration: string;
}

export interface LineFileStructure {
  language: string;
  imports: string[];
  symbols: LineSymbol[];
}

/** First identifier following `keyword `, or null. */
function nameAfter(trimmed: string, keyword: string): string | null {
  const marker = keyword + " ";
  const at = trimmed.indexOf(marker);
  if (at === -1) return null;
  const rest = trimmed.slice(at + marker.length);
  const match = /^[\p{L}\p{N}_]+/u.exec(rest);
  return match ? match[0]! : null;
}

/** Signature text: up to the first `{`, or the whole trimmed line. */
function declaration(trimmed: string): string {
  return (trimmed.split("{")[0] ?? trimmed).trim();
}

/**
 * Extract a defined symbol from one line, or null.
 *
 * Mirrors Swift `FileStructureExtractor.symbol(fromLine:language:)` for the
 * languages this scanner owns. TypeScript/JavaScript are absent on purpose:
 * they are handled by the compiler-API scanner, not here.
 */
export function symbolFromLine(line: string, language: string): LineSymbol | null {
  const trimmed = line.trim();
  const make = (name: string, kind: string): LineSymbol => ({
    name, kind, line: 0, declaration: declaration(trimmed),
  });

  switch (language) {
    case "swift": {
      for (const [keyword, kind] of [
        ["func", "function"], ["class", "class"], ["struct", "struct"],
        ["enum", "enum"], ["protocol", "protocol"], ["extension", "extension"],
      ] as const) {
        const n = nameAfter(trimmed, keyword);
        if (n) return make(n, kind);
      }
      return null;
    }
    case "kotlin": {
      for (const [keyword, kind] of [
        ["class", "class"], ["fun", "function"], ["object", "class"],
        ["interface", "interface"],
      ] as const) {
        const n = nameAfter(trimmed, keyword);
        if (n) return make(n, kind);
      }
      return null;
    }
    case "python": {
      // Line-based: `def`/`async def`/`class` at any indentation. The Swift
      // engine uses a real AST here, so it also sees symbols this misses
      // (conditional or dynamically-built definitions).
      if (/^(async\s+)?def\s/.test(trimmed)) {
        const n = nameAfter(trimmed, "def");
        if (n) return make(n, "function");
      }
      const cls = nameAfter(trimmed, "class");
      if (cls && trimmed.startsWith("class ")) {
        // Python signatures end at `(` or `:`, not `{`.
        return { name: cls, kind: "class", line: 0,
                 declaration: (trimmed.split(":")[0] ?? trimmed).trim() };
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * Extract an imported module specifier from one line, or null.
 *
 * Mirrors Swift's `importSpecifier` for `swift`, and extends it to Kotlin and
 * Python, which the Swift line reader does not cover (Kotlin has no case there;
 * Python is handled by its AST extractor).
 */
export function importFromLine(line: string, language: string): string | null {
  const trimmed = line.trim();
  switch (language) {
    case "swift":
    case "kotlin": {
      if (!trimmed.startsWith("import ")) return null;
      const mod = trimmed.slice("import ".length).trim();
      const first = mod.split(/\s+/)[0];
      return first ? first.replace(/;$/, "") : null;
    }
    case "python": {
      // `import a.b`, `import a as b`, `from a.b import c`
      const from = /^from\s+([\w.]+)\s+import\s/.exec(trimmed);
      if (from) return from[1]!;
      const plain = /^import\s+([\w.]+)/.exec(trimmed);
      if (plain) return plain[1]!;
      return null;
    }
    default:
      return null;
  }
}

/** Read and extract one file. Unreadable files yield null rather than throwing:
 *  a scan must not abort because one file is missing or binary. */
export function scanFileByLines(absPath: string): LineFileStructure | null {
  const language = lineScannedLanguage(absPath);
  if (!language) return null;
  let text: string;
  try {
    text = readFileSync(absPath, "utf8");
  } catch {
    return null;
  }
  const lines = text.split("\n");
  const imports: string[] = [];
  const symbols: LineSymbol[] = [];
  const seenImports = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const imported = importFromLine(line, language);
    if (imported && !seenImports.has(imported)) {
      seenImports.add(imported);
      imports.push(imported);
      continue;
    }
    const symbol = symbolFromLine(line, language);
    if (symbol) symbols.push({ ...symbol, line: i + 1 });
  }
  return { language, imports, symbols };
}
