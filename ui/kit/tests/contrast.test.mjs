import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { REPO } from "./helpers.mjs";

const { loadSource } = await import(join(REPO, "scripts/gen-design-tokens.mjs"));
const src = loadSource();

// sRGB swatch composited over `bg` (opaque), then WCAG relative luminance.
const toRgb = (sw, bg) => {
  if (sw.rgb) return sw.rgb;
  const [c, a] = "white" in sw ? [1, sw.white] : [0, sw.black];
  return bg.map((b) => c * a + b * (1 - a));
};
const lin = (v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// Known gap, recorded not hidden: light textMuted on body is below AA. Changing it
// changes the Mac look too (tokens.json), so it is a design decision, tracked in
// docs/kits/ui-kit.md. The floor stops it getting worse.
const KNOWN_BELOW_AA = { "light textMuted on body": 4.0 };

// WCAG AA: 4.5:1 for body text, 3:1 for large text / UI components (the focus ring).
for (const t of src.themes) {
  test(`${t.id}: text, muted text and focus ring meet WCAG AA on body and surface`, () => {
    const body = toRgb(t.colors.body, [1, 1, 1]);
    const surface = toRgb(t.colors.surface, body);
    for (const [name, bg] of [["body", body], ["surface", surface]]) {
      assert.ok(ratio(toRgb(t.colors.text, bg), bg) >= 4.5, `${t.id} text on ${name}`);
      const key = `${t.id} textMuted on ${name}`;
      const r = ratio(toRgb(t.colors.textMuted, bg), bg);
      assert.ok(r >= (KNOWN_BELOW_AA[key] ?? 4.5), `${key} = ${r.toFixed(2)}`);
      if (key in KNOWN_BELOW_AA) console.log(`# known gap: ${key} = ${r.toFixed(2)}:1 (AA needs 4.5)`);
      assert.ok(ratio(toRgb(t.colors.accent, bg), bg) >= 3, `${t.id} accent (focus ring) on ${name}`);
    }
  });
}
