const integer = new Intl.NumberFormat('en-US');

export function fmtInt(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return integer.format(Math.round(value));
}

/** Share of a whole as a whole percentage, 0 when the whole is empty. */
export function pct(part: number, whole: number): number {
  if (!(whole > 0) || !Number.isFinite(part)) return 0;
  return Math.max(0, Math.min(100, Math.round((part / whole) * 100)));
}

/**
 * A server timestamp as local time. The server writes SQLite times without a
 * zone ("2026-10-26 13:56:08", UTC); ISO strings already carry one.
 */
export function fmtTime(value: string | null | undefined): string {
  if (!value) return '—';
  const hasZone = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(value);
  const ms = Date.parse(hasZone ? value : `${value.replace(' ', 'T')}Z`);
  if (Number.isNaN(ms)) return value;
  return new Date(ms).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** A kind such as "knowledge_updated" as words. */
export function words(value: string): string {
  return value.replace(/[_-]+/g, ' ');
}

/** The short form of a commit SHA. */
export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : '—';
}
