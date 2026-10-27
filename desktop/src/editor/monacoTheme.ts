// Monaco theme derived from the generated CSS tokens (tokens.css), so the editor
// follows Dark / Light / Midnight exactly like the rest of the shell.
import { monaco } from "./monacoEnv";

export const THEME_NAME = "llmide";

/** Parses a computed CSS colour (`rgb()`, `rgba()` or `#rrggbb[aa]`) to Monaco's `#rrggbb[aa]`. */
export function toMonacoColor(css: string): string | null {
  const v = css.trim();
  if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(v)) return v.toLowerCase();
  const m = /^rgba?\(\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*(?:[,/]\s*([\d.]+%?))?\s*\)$/i.exec(v);
  if (!m) return null;
  const channel = (s: string) => Math.round(Math.min(255, Math.max(0, Number(s)))).toString(16).padStart(2, "0");
  const alphaRaw = m[4];
  const alpha = alphaRaw === undefined ? 1 : alphaRaw.endsWith("%") ? Number(alphaRaw.slice(0, -1)) / 100 : Number(alphaRaw);
  const hex = `#${channel(m[1] ?? "0")}${channel(m[2] ?? "0")}${channel(m[3] ?? "0")}`;
  return alpha >= 1 ? hex : `${hex}${channel(String(alpha * 255))}`;
}

/** `#rrggbb` with an extra alpha byte, for selection and highlight overlays. */
function withAlpha(hex: string, alpha: string): string {
  return `${hex.slice(0, 7)}${alpha}`;
}

function readToken(cs: CSSStyleDeclaration, name: string): string | null {
  return toMonacoColor(cs.getPropertyValue(name));
}

/** Monospace font from the token stack (`--font-mono-*`). */
export function editorFontOptions(): { fontFamily: string; fontSize: number } {
  const cs = getComputedStyle(document.documentElement);
  const family = cs.getPropertyValue("--font-mono-family").trim() || "monospace";
  const size = parseFloat(cs.getPropertyValue("--font-mono-size")) || 12;
  return { fontFamily: family, fontSize: size };
}

/**
 * (Re)defines the `llmide` theme from the current `data-theme` tokens and applies it
 * to every live editor. Safe to call on each theme change.
 */
export function applyMonacoTheme(): void {
  const cs = getComputedStyle(document.documentElement);
  const light = document.documentElement.dataset.theme === "light";
  const colors: Record<string, string> = {};
  const put = (key: string, token: string) => {
    const c = readToken(cs, token);
    if (c) colors[key] = c;
  };
  put("editor.background", "--editor-background");
  put("editor.foreground", "--text");
  put("editorLineNumber.foreground", "--editor-line-number");
  put("editorLineNumber.activeForeground", "--text");
  put("editorCursor.foreground", "--accent");
  put("editor.lineHighlightBackground", "--row-alt");
  put("editorIndentGuide.background1", "--grid-line");
  put("editorGutter.background", "--body");
  put("editorWidget.background", "--surface");
  put("editorWidget.border", "--border");
  put("editorSuggestWidget.background", "--surface");
  put("editorSuggestWidget.border", "--border");
  put("editorHoverWidget.background", "--surface2");
  put("editorHoverWidget.border", "--border");
  put("list.hoverBackground", "--surface2");
  put("list.activeSelectionBackground", "--surface2");
  put("list.activeSelectionForeground", "--text");
  const accent = readToken(cs, "--accent");
  if (accent) {
    colors["editor.selectionBackground"] = withAlpha(accent, "66");
    colors["editor.inactiveSelectionBackground"] = withAlpha(accent, "33");
  }

  const rule = (token: string, varName: string, fontStyle?: string) => {
    const c = readToken(cs, varName);
    return { token, foreground: (c ?? "#808080").slice(1, 7), ...(fontStyle ? { fontStyle } : {}) };
  };
  monaco.editor.defineTheme(THEME_NAME, {
    base: light ? "vs" : "vs-dark",
    inherit: true,
    rules: [
      rule("comment", "--text-muted", "italic"),
      rule("keyword", "--accent2"),
      rule("string", "--accent3"),
      rule("number", "--accent4"),
      rule("type", "--category-teal"),
      rule("identifier", "--text"),
      rule("delimiter", "--text-muted"),
    ],
    colors,
  });
  monaco.editor.setTheme(THEME_NAME);
  const font = editorFontOptions();
  for (const ed of monaco.editor.getEditors()) ed.updateOptions(font);
}
