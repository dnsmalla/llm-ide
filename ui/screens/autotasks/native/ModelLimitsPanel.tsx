// Model & Limits: the per-user model chain and its caps, read from and saved to the server (/kb/usage/*). The runner
// reads the same chain through /kb/usage/resolve before each run, so a cap set here applies to desktop runs.
import { useEffect, useState, type ReactNode } from "react";
import { core } from "../../shell/runtime";
import { limitsBody, meterText, moveRow, providersToSave, type ChainRow, type RateSnapshot, type Summary, type SummaryRow, type UsageUnit, type UsageWindow } from "./usage.ts";

const RATE_LABELS: Array<[keyof Omit<RateSnapshot, "capturedAt" | "provider" | "model">, string]> = [
  ["requests", "Requests"], ["tokens", "Tokens"], ["inputTokens", "Input tokens"], ["outputTokens", "Output tokens"],
];

export function ModelLimitsPanel({ onClose, embedded = false }: { onClose: () => void; embedded?: boolean }): ReactNode {
  const [rows, setRows] = useState<Record<string, ChainRow[]>>({});
  const [summary, setSummary] = useState<Summary | null>(null);
  const [rate, setRate] = useState<RateSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Providers the user changed: Save writes only these, as the Mac saves only the provider on screen. */
  const [dirty, setDirty] = useState<Set<string>>(new Set());

  const load = async () => {
    setBusy(true); setError(null);
    try {
      const [s, r] = await Promise.all([
        core.request<Summary>("/kb/usage/summary"),
        core.request<{ ratelimits: RateSnapshot | null }>("/kb/usage/ratelimits?provider=anthropic"),
      ]);
      setSummary(s); setRate(r.ratelimits);
      const next: Record<string, ChainRow[]> = {};
      const provs: Summary["providers"] = s.providers;
      for (const [provider, block] of Object.entries(provs)) {
        next[provider] = block.models.map((m: SummaryRow) => ({
          provider, model: m.model, label: m.label, priority: m.priority, enabled: m.enabled, limit_value: m.limit,
          unit: m.unit, window_kind: m.window_kind, threshold_pct: m.threshold_pct, custom: m.custom,
        }));
      }
      setRows(next);
      setDirty(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read model limits.");
    } finally { setBusy(false); }
  };
  useEffect(() => { void load(); }, []);

  const markDirty = (provider: string) => setDirty((d) => new Set(d).add(provider));
  const edit = (provider: string, index: number, patch: Partial<ChainRow>) => {
    markDirty(provider);
    setRows((all) => ({ ...all, [provider]: (all[provider] ?? []).map((r, i) => (i === index ? { ...r, ...patch } : r)) }));
  };
  const move = (provider: string, index: number, delta: -1 | 1) => {
    markDirty(provider);
    setRows((all) => ({ ...all, [provider]: moveRow(all[provider] ?? [], index, delta) }));
  };

  const save = async () => {
    setBusy(true); setError(null); setSaved(null);
    try {
      for (const [provider, list] of providersToSave(rows, dirty)) {
        await core.request("/kb/usage/limits", { method: "PUT", body: limitsBody(provider, list) });
      }
      setSaved("Limits saved. The next run uses them.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save limits.");
    } finally { setBusy(false); }
  };

  const body = (
    <>
        <p className="atn-hint">Models are tried in this order. When a model reaches its cap, the next enabled one is used. A task does not run when every model is at its cap.</p>
        {error ? <p className="atn-error" role="alert">{error}</p> : null}
        {saved ? <p className="atn-notice" role="status">{saved}</p> : null}
        {Object.entries(rows).map(([provider, list]) => (
          <section key={provider}>
            <h3 className="atn-group">{provider}{summary?.providers[provider]?.active.model ? ` · active ${summary.providers[provider].active.model}` : ""}</h3>
            {list.length === 0 ? <p className="atn-hint">No models configured.</p> : null}
            {list.map((r, i) => {
              const s = summary?.providers[provider]?.models.find((m) => m.model === r.model);
              return (
                <div className="atn-limit-row" key={`${provider}:${r.model}`}>
                  <label className="atn-inline"><input type="checkbox" checked={r.enabled} onChange={(e) => edit(provider, i, { enabled: e.target.checked })} aria-label={`${r.label} enabled`} /> {r.label}</label>
                  <span className="atn-hint">{s ? `${meterText(s.used, s.limit, s.unit)} · ${s.state}` : ""}</span>
                  <input type="number" min={0} aria-label={`${r.label} cap`} value={r.limit_value} onChange={(e) => edit(provider, i, { limit_value: Number(e.target.value) })} />
                  <select aria-label={`${r.label} unit`} value={r.unit} onChange={(e) => edit(provider, i, { unit: e.target.value as UsageUnit })}><option value="runs">runs</option><option value="tokens">tokens</option></select>
                  <select aria-label={`${r.label} window`} value={r.window_kind} onChange={(e) => edit(provider, i, { window_kind: e.target.value as UsageWindow })}><option value="daily">daily</option><option value="monthly">monthly</option></select>
                  <input type="number" min={1} max={100} aria-label={`${r.label} switch at %`} value={r.threshold_pct} onChange={(e) => edit(provider, i, { threshold_pct: Number(e.target.value) })} />
                  <button type="button" className="atn-icon" aria-label={`Move ${r.label} up`} disabled={i === 0} onClick={() => move(provider, i, -1)}>↑</button>
                  <button type="button" className="atn-icon" aria-label={`Move ${r.label} down`} disabled={i === list.length - 1} onClick={() => move(provider, i, 1)}>↓</button>
                </div>
              );
            })}
          </section>
        ))}
        <section>
          <h3 className="atn-group">API rate limits</h3>
          {rate ? (
            <ul className="atn-rate">{RATE_LABELS.map(([k, label]) => { const b = rate[k]; return b ? <li key={k}>{label}: {b.remaining ?? "?"} of {b.limit ?? "?"} left{b.reset ? `, resets ${b.reset}` : ""}</li> : null; })}</ul>
          ) : <p className="atn-hint">No API rate-limit data yet. It appears after the first API call.</p>}
        </section>
        <div className="atn-modal-actions">
          <button type="button" className="atn-btn" disabled={busy} onClick={() => void load()}>Refresh</button>
          {embedded ? null : <button type="button" className="atn-btn" onClick={onClose}>Close</button>}
          <button type="button" className="atn-btn atn-primary" disabled={busy || dirty.size === 0} onClick={() => void save()}>Save</button>
        </div>
    </>
  );
  if (embedded) return <div className="atn-limits-embed">{body}</div>;
  return (
    <div className="atn-modal" role="dialog" aria-modal="true" aria-labelledby="atn-limits-title">
      <div className="atn-modal-card atn-limits">
        <header><h2 id="atn-limits-title">Model &amp; Limits</h2><span className="atn-spacer" /><button type="button" className="atn-icon" aria-label="Close model limits" onClick={onClose}>×</button></header>
        {body}
      </div>
    </div>
  );
}
