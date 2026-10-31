// CSS colour -> Monaco colour. Pure (no Monaco import), so it is unit-tested with node.
// Custom properties are returned as WRITTEN by getComputedStyle (`rgb(7% 8% 11%)` from the generated
// tokens), so percentage channels and the space / slash syntax have to be understood, not only `#rrggbb`.

/** Parses `#rrggbb[aa]`, `rgb()` / `rgba()` (comma or space syntax, percentage or number channels, `/ alpha`) to `#rrggbb[aa]`. */
export function toMonacoColor(css: string): string | null {
  const v = css.trim();
  if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(v)) return v.toLowerCase();
  const m = /^rgba?\(\s*([\d.]+%?)\s*[,\s]\s*([\d.]+%?)\s*[,\s]\s*([\d.]+%?)\s*(?:[,/]\s*([\d.]+%?))?\s*\)$/i.exec(v);
  if (!m) return null;
  const channel = (s: string) => {
    const n = s.endsWith("%") ? (Number(s.slice(0, -1)) / 100) * 255 : Number(s);
    return Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, "0");
  };
  const alphaRaw = m[4];
  const alpha = alphaRaw === undefined ? 1 : alphaRaw.endsWith("%") ? Number(alphaRaw.slice(0, -1)) / 100 : Number(alphaRaw);
  const hex = `#${channel(m[1] ?? "0")}${channel(m[2] ?? "0")}${channel(m[3] ?? "0")}`;
  return alpha >= 1 ? hex : `${hex}${channel(String(alpha * 255))}`;
}
