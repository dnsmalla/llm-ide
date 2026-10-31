// Pre-filter for mermaid diagram text. The text is model output (untrusted). Mermaid honours in-text configuration
// (`%%{init: ...}%%` directives and YAML front matter with a `config:` block), which could switch `securityLevel` to
// `loose`, so BOTH are removed before the text goes anywhere near the renderer. `click` interaction lines are removed
// too (strict level already disables them: this is the second layer). The frame also pins the config with mermaid's
// `secure` list and verifies the level after the render; this filter is not the only control.

export const MAX_SOURCE_BYTES = 100 * 1024;
export const MAX_SOURCE_LINES = 5000;

export type PrefilterResult = { ok: true; source: string; removed: string[] } | { ok: false; reason: string };

/** Fenced-code `lang` values that mean "a mermaid diagram". */
export function isMermaidLang(lang: string): boolean {
  return /^mermaid$/i.test(lang.trim().split(/\s+/)[0] ?? "");
}

const FRONT_MATTER = /^\s*---[ \t]*\n[\s\S]*?\n---[ \t]*(?:\n|$)/;
const DIRECTIVE = /%%\{[\s\S]*?\}%%/g;
const CLICK_LINE = /(^|;)[ \t]*(?:click|callback)[ \t][^\n;]*/gim;

export function prefilterMermaid(raw: unknown): PrefilterResult {
  if (typeof raw !== "string") return { ok: false, reason: "The diagram text is not text." };
  if (new TextEncoder().encode(raw).length > MAX_SOURCE_BYTES) return { ok: false, reason: `The diagram is larger than ${MAX_SOURCE_BYTES / 1024} KB.` };
  if (raw.includes("\0")) return { ok: false, reason: "The diagram contains a NUL character." };
  const removed: string[] = [];
  let s = raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  for (let i = 0; i < 4 && FRONT_MATTER.test(s); i += 1) {
    s = s.replace(FRONT_MATTER, "");
    removed.push("front matter");
  }
  if (/^\s*---/.test(s)) return { ok: false, reason: "The diagram starts with unsupported front matter." };
  // Fixpoint: removing one directive can splice the pieces of another together (`%%{in%%{x}%%it...}%%`).
  for (let i = 0; i < 20 && s.includes("%%{"); i += 1) {
    const before = s;
    s = s.replace(DIRECTIVE, () => {
      removed.push("directive");
      return "";
    });
    if (s === before) {
      // Unterminated `%%{`: drop to the end of that line.
      s = s.replace(/%%\{[^\n]*/g, () => {
        removed.push("directive");
        return "";
      });
    }
  }
  if (s.includes("%%{")) return { ok: false, reason: "The diagram holds a configuration directive that could not be removed." };
  s = s.replace(CLICK_LINE, (_m, lead: string) => {
    removed.push("click");
    return lead;
  });
  if (s.split("\n").length > MAX_SOURCE_LINES) return { ok: false, reason: `The diagram has more than ${MAX_SOURCE_LINES} lines.` };
  if (!s.trim()) return { ok: false, reason: "The diagram is empty." };
  return { ok: true, source: s, removed };
}
