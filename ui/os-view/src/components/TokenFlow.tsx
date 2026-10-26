import type { OsState, UsageCounts } from '../types';
import { fmtInt, pct, words } from '../format';
import { Bar, Card, Empty } from './common';

type Tokens = OsState['tokens'];

type Row = { key: string; label: string; detail: string; billable: number; calls: number };

/** Top five rows by billable tokens, bars scaled to the largest. */
function Breakdown({ rows, label }: { rows: Row[]; label: string }) {
  const top = [...rows].sort((a, b) => b.billable - a.billable).slice(0, 5);
  const max = top.reduce((m, r) => Math.max(m, r.billable), 0);
  if (top.length === 0) return <p className="meta">No {label} in this window.</p>;
  return (
    <ul className="breakdown">
      {top.map((row) => (
        <li key={row.key}>
          <div className="breakdown-head">
            <span>
              {row.label}
              {row.detail ? <span className="meta"> · {row.detail}</span> : null}
            </span>
            <span className="meta">
              {fmtInt(row.billable)} billable · {fmtInt(row.calls)} calls
            </span>
          </div>
          <Bar value={row.billable} max={max} label={`${row.label}: ${fmtInt(row.billable)} billable tokens`} />
        </li>
      ))}
    </ul>
  );
}

function Totals({ totals }: { totals: UsageCounts }) {
  const items: Array<[string, number]> = [
    ['Calls', totals.calls],
    ['Input', totals.input],
    ['Output', totals.output],
    ['Cache read', totals.cacheRead],
    ['Cache write', totals.cacheWrite],
    ['Billable', totals.billable],
  ];
  return (
    <dl className="totals">
      {items.map(([name, value]) => (
        <div key={name}>
          <dt>{name}</dt>
          <dd>{fmtInt(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

export function TokenFlow({ tokens }: { tokens: Tokens }) {
  const { totals, turnComposition: turns } = tokens;
  const promptTokens = totals.input + totals.cacheRead + totals.cacheWrite;
  const windowLabel = tokens.window === 'day' ? 'today (since midnight)' : 'the last 7 days (incl. today)';

  // Per-turn split, from the first call's real prompt size. The static prefix and the
  // injected context are chars/4 estimates, so the remainder is an estimate too.
  const prefix = turns.avgPrefixTokens ?? 0;
  const fence = turns.avgFenceTokens ?? 0;
  const toolResults = turns.avgToolResultTokens ?? 0;
  const firstCall = turns.avgFirstCallPromptTokens;
  const other = firstCall === null ? 0 : Math.max(0, firstCall - prefix - fence - toolResults);
  const compositionRows = [
    { label: 'Static prefix', value: prefix },
    { label: 'Injected context', value: fence },
    { label: 'Tool results', value: toolResults },
    { label: 'Transcript and other', value: other },
  ];
  const compositionMax = Math.max(1, ...compositionRows.map((r) => r.value));

  return (
    <Card id="sec-tokens" title="Token flow">
      <p className="meta">Window: {windowLabel}.</p>
      {totals.calls === 0 ? (
        <Empty>No model calls in this window yet.</Empty>
      ) : (
        <>
          <Totals totals={totals} />
          <h3 className="sub-title">Cache</h3>
          <p className="meta">
            Cache read is {pct(totals.cacheRead, promptTokens)}% of prompt tokens; cache write is{' '}
            {pct(totals.cacheWrite, promptTokens)}%.
          </p>
          <Bar value={totals.cacheRead} max={promptTokens} label="Cache read share of prompt tokens" />
          <h3 className="sub-title">By model</h3>
          <Breakdown
            label="models"
            rows={tokens.byModel.map((m) => ({
              key: `${m.provider}/${m.model}`,
              label: m.model,
              detail: m.provider,
              billable: m.billable,
              calls: m.calls,
            }))}
          />
          <h3 className="sub-title">By source</h3>
          <Breakdown
            label="sources"
            rows={tokens.bySource.map((s) => ({
              key: s.source,
              label: words(s.source),
              detail: '',
              billable: s.billable,
              calls: s.calls,
            }))}
          />
          <h3 className="sub-title">By endpoint</h3>
          <Breakdown
            label="endpoints"
            rows={tokens.byEndpoint.map((e) => ({
              key: e.endpoint ?? 'unknown',
              label: e.endpoint ?? 'unknown',
              detail: '',
              billable: e.billable,
              calls: e.calls,
            }))}
          />
        </>
      )}
      <h3 className="sub-title">
        Per chat turn, average of {fmtInt(turns.turns)} {turns.turns === 1 ? 'turn' : 'turns'}
      </h3>
      {turns.turns === 0 ? (
        <Empty>No chat turns recorded yet.</Empty>
      ) : (
        <>
          <ul className="composition">
            {compositionRows.map((row) => (
              <li key={row.label}>
                <div className="breakdown-head">
                  <span>{row.label}</span>
                  <span className="meta">{fmtInt(row.value)} tokens</span>
                </div>
                <Bar value={row.value} max={compositionMax} label={`${row.label}: ${fmtInt(row.value)} tokens`} />
              </li>
            ))}
          </ul>
          <p className="meta">
            First-call prompt: {firstCall === null ? 'not recorded' : `${fmtInt(firstCall)} tokens`}. The split above
            is estimated (chars / 4); the remainder is what the first call sent beyond the prefix and context.
          </p>
        </>
      )}
    </Card>
  );
}
