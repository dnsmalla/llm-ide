// xterm theme from the generated design tokens (tokens.css), so the terminal follows
// Dark / Light / Midnight like the rest of the shell. xterm parses the computed
// `rgb(...)` strings directly.
import type { ITheme } from "@xterm/xterm";

const FALLBACK_FONT = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

function token(cs: CSSStyleDeclaration, name: string, fallback: string): string {
  return cs.getPropertyValue(name).trim() || fallback;
}

/** `rgb(r, g, b)` with an alpha channel, for the selection overlay. */
function withAlpha(color: string, alpha: number): string {
  const m = /^rgba?\((.*)\)$/.exec(color);
  if (!m) return color;
  const parts = (m[1] ?? "").split(",").slice(0, 3).map((s) => s.trim());
  return `rgba(${parts.join(", ")}, ${alpha})`;
}

export function xtermTheme(): ITheme {
  const cs = getComputedStyle(document.documentElement);
  const accent = token(cs, "--accent", "rgb(102, 184, 209)");
  const text = token(cs, "--text", "rgb(230, 230, 230)");
  const muted = token(cs, "--text-muted", "rgb(140, 140, 140)");
  const body = token(cs, "--body", "rgb(20, 20, 22)");
  return {
    background: body,
    foreground: text,
    cursor: accent,
    cursorAccent: body,
    selectionBackground: withAlpha(accent, 0.4),
    black: token(cs, "--surface2", body),
    red: token(cs, "--danger", "rgb(230, 90, 90)"),
    green: token(cs, "--accent3", "rgb(97, 230, 166)"),
    yellow: token(cs, "--accent4", "rgb(250, 209, 102)"),
    blue: token(cs, "--accent2", "rgb(140, 179, 255)"),
    magenta: token(cs, "--category-purple", "rgb(179, 143, 242)"),
    cyan: token(cs, "--category-teal", "rgb(107, 199, 209)"),
    white: text,
    brightBlack: muted,
    brightRed: token(cs, "--danger", "rgb(230, 90, 90)"),
    brightGreen: token(cs, "--accent3", "rgb(97, 230, 166)"),
    brightYellow: token(cs, "--accent4", "rgb(250, 209, 102)"),
    brightBlue: token(cs, "--accent2", "rgb(140, 179, 255)"),
    brightMagenta: token(cs, "--category-purple", "rgb(179, 143, 242)"),
    brightCyan: token(cs, "--category-teal", "rgb(107, 199, 209)"),
    brightWhite: text,
  };
}

/** Monospace stack and size from the `--font-mono-*` tokens. */
export function terminalFont(): { fontFamily: string; fontSize: number } {
  const cs = getComputedStyle(document.documentElement);
  const family = token(cs, "--font-mono", FALLBACK_FONT);
  const size = parseFloat(cs.getPropertyValue("--font-mono-size")) || 13;
  return { fontFamily: family, fontSize: size };
}
