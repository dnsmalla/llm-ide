// Tab labels: the file name, plus the shortest parent suffix that tells identical names apart. Pure.
export function tabLabels(paths: readonly string[]): Map<string, { label: string; hint: string | null }> {
  const byName = new Map<string, string[]>();
  for (const p of paths) {
    const n = p.slice(p.lastIndexOf("/") + 1);
    byName.set(n, [...(byName.get(n) ?? []), p]);
  }
  const out = new Map<string, { label: string; hint: string | null }>();
  for (const p of paths) {
    const name = p.slice(p.lastIndexOf("/") + 1);
    const same = byName.get(name) ?? [p];
    if (same.length === 1) {
      out.set(p, { label: name, hint: null });
      continue;
    }
    const segs = p.split("/");
    // Grow the suffix until it is unique among the colliding paths.
    let k = 1;
    const parentsOf = (q: string) => q.split("/").slice(0, -1);
    while (k < segs.length - 1) {
      const mine = parentsOf(p).slice(-k).join("/");
      if (same.filter((q) => q !== p).every((q) => parentsOf(q).slice(-k).join("/") !== mine)) break;
      k++;
    }
    const hint = parentsOf(p).slice(-k).join("/");
    out.set(p, { label: name, hint: hint === "" ? null : hint });
  }
  return out;
}

/** "1.2 MB" style size. */
export function formatSize(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
