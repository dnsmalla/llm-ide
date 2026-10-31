// Ranking for the completion menu. Tiers within a group (the Mac's order, plus a fuzzy tier): label prefix, label
// contains, label subsequence ("gsk" finds "graph-skill"), description contains. Search keys are precomputed when
// the items are built, so a keystroke allocates only the output arrays: 5,000 items rank in a couple of ms.

export interface Rankable { searchLabel: string; searchDetail: string }

/** True when every char of `q` appears in `s` in order. */
export function isSubsequence(q: string, s: string): boolean {
  if (q.length > s.length) return false;
  let i = 0;
  for (let j = 0; j < s.length && i < q.length; j++) if (s.charCodeAt(j) === q.charCodeAt(i)) i++;
  return i === q.length;
}

/** Stable tiered ranking; an empty query keeps the pool order. `q` must already be lowercased. */
export function rank<T extends Rankable>(pool: readonly T[], q: string): T[] {
  if (q === "") return pool.slice();
  const a: T[] = [], b: T[] = [], c: T[] = [], d: T[] = [];
  for (const it of pool) {
    if (it.searchLabel.startsWith(q)) a.push(it);
    else if (it.searchLabel.includes(q)) b.push(it);
    else if (q.length >= 2 && isSubsequence(q, it.searchLabel)) c.push(it);
    else if (it.searchDetail.includes(q)) d.push(it);
  }
  return a.concat(b, c, d);
}

/** Index of the best GLOBAL match (a label-prefix hit in a later group beats an earlier weak hit), else 0. */
export function bestIndex<T extends Rankable>(items: readonly T[], q: string): number {
  if (q === "") return 0;
  const i = items.findIndex((x) => x.searchLabel.startsWith(q));
  return i < 0 ? 0 : i;
}
