// Filters: preset (All / Code / Docs), node kinds, community, edge-weight slider. Filters hide at render;
// nothing is removed from the graph, and the slider's default is the Mac's 0.30 floor.
import { communityColor } from "./colors.ts";
import type { CommunityInfo, FilterState, Preset } from "./filters.ts";
import type { GraphModel } from "./model.ts";

export interface ControlsProps {
  model: GraphModel;
  communities: CommunityInfo[];
  filters: FilterState;
  onChange: (patch: Partial<FilterState>) => void;
}

const PRESETS: { id: Preset; label: string }[] = [
  { id: "all", label: "All" },
  { id: "code", label: "Code" },
  { id: "docs", label: "Docs" },
];

export function Controls({ model, communities, filters, onChange }: ControlsProps) {
  const toggleKind = (k: string) => {
    const next = new Set(filters.hiddenKinds);
    if (next.has(k)) next.delete(k); else next.add(k);
    onChange({ hiddenKinds: next });
  };
  return (
    <section className="gr-controls" aria-label="Graph filters">
      <div role="radiogroup" aria-label="Graph mode" className="gr-seg">
        {PRESETS.map((p) => (
          <button key={p.id} type="button" role="radio" aria-checked={filters.preset === p.id} className="gr-seg-btn" data-on={filters.preset === p.id} onClick={() => onChange({ preset: p.id })}>{p.label}</button>
        ))}
      </div>
      <label className="gr-field">
        <span>Minimum edge weight: {filters.minWeight.toFixed(2)}</span>
        <input type="range" min={0} max={1} step={0.05} value={filters.minWeight} aria-valuetext={`${filters.minWeight.toFixed(2)}`} onChange={(e) => onChange({ minWeight: Number(e.target.value) })} />
      </label>
      <fieldset className="gr-fieldset">
        <legend>Node kinds</legend>
        {model.nodeKinds.map((k) => (
          <label key={k} className="gr-check"><input type="checkbox" checked={!filters.hiddenKinds.has(k)} onChange={() => toggleKind(k)} /> {k}</label>
        ))}
      </fieldset>
      <label className="gr-field">
        <span>Community</span>
        <select value={filters.community ?? ""} onChange={(e) => onChange({ community: e.target.value === "" ? null : Number(e.target.value) })}>
          <option value="">All communities</option>
          {communities.slice(0, 100).map((c) => (
            <option key={c.id} value={c.id}>{`${c.id + 1} · ${c.size.toLocaleString("en-US")} nodes · ${model.titles[c.label]}`}</option>
          ))}
        </select>
      </label>
      <ul className="gr-legend" aria-label="Largest communities">
        {communities.slice(0, 8).map((c) => (
          <li key={c.id}><span className="gr-dot" style={{ background: communityColor(c.id) }} aria-hidden="true" /> {c.id + 1}: {model.titles[c.label]}</li>
        ))}
      </ul>
    </section>
  );
}
