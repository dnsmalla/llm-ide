// One-line summary of how the meeting-agent's questions are landing.
// Polls /kb/agent/feedback/stats every 30s while mounted.  Lives in
// Settings (alongside the persona editor) because that's where you
// go to tune the agent — seeing useful-rate next to the controls
// closes the feedback loop visually.
//
// Deliberately minimal — no chart, no per-task drill-down.  The full
// breakdown shows on hover.

import React, { useEffect, useState } from 'react';
import { authFetch, getServerUrl } from '../../lib/config';

interface Stats {
  total: number;
  byVerdict: { useful: number; noise: number; later: number };
  usefulRate: number | null;
  avgScore: { useful?: number; noise?: number; later?: number };
  sinceDays: number;
}

const POLL_MS = 30_000;

export default function AgentStatsBadge(): JSX.Element | null {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    async function tick() {
      try {
        const url = await getServerUrl();
        const r = await authFetch(`${url}/kb/agent/feedback/stats`);
        if (r.ok) {
          const j: Stats = await r.json();
          if (!cancelled) setStats(j);
        }
      } catch {
        /* ignore */
      }
      if (!cancelled) timer = setTimeout(tick, POLL_MS);
    }
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  // No data yet (still loading or no feedback ever recorded) → render
  // nothing.  We don't want a "0 questions rated" line distracting
  // users who haven't dogfooded yet.
  if (!stats || stats.total === 0) return null;

  const rate = stats.usefulRate != null ? `${Math.round(stats.usefulRate * 100)}% useful` : '—';
  const tooltip = [
    `${stats.byVerdict.useful} useful, ${stats.byVerdict.noise} noise, ${stats.byVerdict.later} later`,
    stats.avgScore.useful != null ? `avg score (useful): ${stats.avgScore.useful.toFixed(2)}` : null,
    stats.avgScore.noise != null ? `avg score (noise): ${stats.avgScore.noise.toFixed(2)}` : null,
    `last ${stats.sinceDays} days`,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <p className="settings-hint" title={tooltip}>
      Agent: <strong>{rate}</strong> over {stats.total} question{stats.total === 1 ? '' : 's'}
      <span style={{ opacity: 0.6 }}> ({stats.sinceDays}d)</span>
    </p>
  );
}
