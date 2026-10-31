// Monaco theme derived from the generated CSS tokens (tokens.css), so the editor
// follows Dark / Light / Midnight exactly like the rest of the shell.
import { monaco } from "./monacoEnv";
import { toMonacoColor } from "./colors";

export const THEME_NAME = "llmide";

export { toMonacoColor };

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
  const family = cs.getPropertyValue("--tok-type-mono-family").trim() || "monospace";
  const size = parseFloat(cs.getPropertyValue("--tok-type-mono-size")) || 12;
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
  put("editor.background", "--tok-color-editor-background");
  put("editor.foreground", "--tok-color-text");
  put("editorLineNumber.foreground", "--tok-color-editor-line-number");
  put("editorLineNumber.activeForeground", "--tok-color-text");
  put("editorCursor.foreground", "--tok-color-accent");
  put("editor.lineHighlightBackground", "--tok-color-row-alt");
  put("editorIndentGuide.background1", "--tok-color-grid-line");
  put("editorGutter.background", "--tok-color-body");
  put("editorWidget.background", "--tok-color-surface");
  put("editorWidget.border", "--tok-color-border");
  put("editorSuggestWidget.background", "--tok-color-surface");
  put("editorSuggestWidget.border", "--tok-color-border");
  put("editorHoverWidget.background", "--tok-color-surface2");
  put("editorHoverWidget.border", "--tok-color-border");
  put("list.hoverBackground", "--tok-color-surface2");
  put("list.activeSelectionBackground", "--tok-color-surface2");
  put("list.activeSelectionForeground", "--tok-color-text");
  const accent = readToken(cs, "--tok-color-accent");
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
      rule("comment", "--tok-color-text-muted", "italic"),
      rule("keyword", "--tok-color-accent2"),
      rule("string", "--tok-color-accent3"),
      rule("number", "--tok-color-accent4"),
      rule("type", "--tok-color-category-teal"),
      rule("identifier", "--tok-color-text"),
      rule("delimiter", "--tok-color-text-muted"),
    ],
    colors,
  });
  monaco.editor.setTheme(THEME_NAME);
  const font = editorFontOptions();
  for (const ed of monaco.editor.getEditors()) ed.updateOptions(font);
}
