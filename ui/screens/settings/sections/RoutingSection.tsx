import { useEffect, useMemo, useRef, useState } from "react";
import { cleanFallback, rowsFromCatalog } from "../providers-model.ts";
import { EXTRA_TIERS, MIGRATION_TEXT, RoutingModel, visibleRoles, roleEmptyOptionLabel, preselectedRoles, PRESELECT_HINT, SWITCH_TEXT, TIERS, isDirty, roleFallbackWarning, roleStatusText, tierStatusText } from "../routing-model.ts";
import { ModelListsModel, OTHER_MODEL, pickerView, type ModelListEntry } from "../routing-models.ts";
import { sharedProvidersModel, useEnv, useModel, useRefreshOnFocus, useStore } from "../context.tsx";
import type { CatalogMigration, ProviderSettings, TierChoice } from "../decoders.ts";
import type { SettingsHost } from "../host.ts";
import { Button, ErrorText, NeedsHost, Switch } from "../ui.tsx";
import { StatusBanner } from "@llmide/ui-kit";

const ANTHROPIC = "anthropic";

export default function RoutingSection() {
  const { client, host } = useEnv();
  const routing = useModel(() => new RoutingModel(client));
  const providers = sharedProvidersModel(client);
  const r = useStore(routing);
  const p = useStore(providers);
  // A focus refresh must not throw away edits the user has not saved yet (they often leave to copy a model id).
  useRefreshOnFocus(() => { void routing.load(true); void providers.load(); });

  const rows = useMemo(() => (p.catalog ? rowsFromCatalog(p.catalog) : []), [p.catalog]);
  const options = useMemo(() => [{ id: ANTHROPIC, name: "Anthropic (Claude)" }, ...rows.map((x) => ({ id: x.provider, name: x.name }))], [rows]);
  // The routing provider id of a catalog connection (`custom:cat-groq`) back to its connection id (`cat-groq`).
  const connectionIds = useRef(new Map<string, string>());
  connectionIds.current = new Map(rows.map((x) => [x.provider, x.id]));
  const modelLists = useModel(() => new ModelListsModel(client, (provider) => connectionIds.current.get(provider) ?? null));
  const lists = useStore(modelLists).lists;
  useEffect(() => () => modelLists.dispose(), [modelLists]);
  const chosenProviders = Object.values(r.draft?.tiers ?? {}).map((c) => c.provider).filter(Boolean).sort().join("|");
  useEffect(() => {
    for (const provider of chosenProviders.split("|")) if (provider) void modelLists.ensure(provider);
  }, [chosenProviders, modelLists]);
  const setProvider = (tier: string, current: TierChoice | undefined, provider: string) =>
    routing.setTier(tier, provider ? { provider, model: current && current.provider === provider ? current.model : "" } : null);
  const dirty = isDirty(r.loaded, r.draft) || r.pendingDecision;
  const settings = p.catalog?.settings;

  return (
    <div className="st-stack">
      <p className="st-hint">Which model each job uses. Standard is the default for new chats and every role left on it. A tier that cannot be used is skipped, and its row says what runs instead.</p>
      <ErrorText text={r.error} />
      {r.notice ? <StatusBanner severity={r.noticeKind} message={r.notice} /> : null}
      {r.phase === "loading" ? <p className="st-hint" role="status">Loading routing...</p> : null}
      {r.draft ? (
        <>
          <table className="st-table" aria-label="Tiers">
            <thead><tr><th scope="col">Tier</th><th scope="col">Provider</th><th scope="col">Model</th><th scope="col">Status</th></tr></thead>
            <tbody>
              {TIERS.map((t) => {
                const c = r.draft!.tiers[t.id];
                return (
                  <tr key={t.id}>
                    <th scope="row">{t.label}<div className="st-hint">{t.hint}</div></th>
                    <td>
                      <select className="st-select" aria-label={`${t.label} provider`} value={c?.provider ?? ""} onChange={(e) => setProvider(t.id, c, e.target.value)}>
                        <option value="">None</option>
                        {c && !options.some((o) => o.id === c.provider) ? <option value={c.provider}>{c.provider}</option> : null}
                        {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                      </select>
                    </td>
                    <td><ModelCell label={`${t.label} model`} tier={t.id} choice={c} entry={c ? lists[c.provider] : undefined} onChange={(choice) => routing.setTier(t.id, choice)} onRetry={() => c && void modelLists.ensure(c.provider)} /></td>
                    <td className="st-hint">{tierStatusText(r.loaded?.status[t.id])}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="st-hint">Media and decision models are optional. None is the default: nothing runs on them until you choose one.</p>
          <table className="st-table" aria-label="Media and decision models">
            <thead><tr><th scope="col">Model</th><th scope="col">Provider</th><th scope="col">Model id</th><th scope="col">Status</th></tr></thead>
            <tbody>
              {EXTRA_TIERS.map((t) => {
                const c = r.draft!.tiers[t.id];
                return (
                  <tr key={t.id}>
                    <th scope="row">{t.label}<div className="st-hint">{t.hint}</div></th>
                    <td>
                      <select className="st-select" aria-label={`${t.label} provider`} value={c?.provider ?? ""} onChange={(e) => setProvider(t.id, c, e.target.value)}>
                        <option value="">None</option>
                        {c && !options.some((o) => o.id === c.provider) ? <option value={c.provider}>{c.provider}</option> : null}
                        {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                      </select>
                    </td>
                    <td><ModelCell label={`${t.label} model id`} tier={t.id} choice={c} entry={c ? lists[c.provider] : undefined} onChange={(choice) => routing.setTier(t.id, choice)} onRetry={() => c && void modelLists.ensure(c.provider)} /></td>
                    <td className="st-hint">{c ? tierStatusText(r.loaded?.status[t.id]) : "None"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {dirty && preselectedRoles(r.loaded, r.draft).length > 0 ? <p className="st-hint" role="status">{PRESELECT_HINT}</p> : null}
          {roleFallbackWarning(r.draft) ? <StatusBanner severity="warning" message={roleFallbackWarning(r.draft)!} /> : null}
          <table className="st-table" aria-label="Roles">
            <thead><tr><th scope="col">Role</th><th scope="col">Tier</th><th scope="col">Status</th></tr></thead>
            <tbody>
              {visibleRoles(r.loaded).map((role) => (
                <tr key={role.id}>
                  <th scope="row">{role.label}</th>
                  <td>
                    <select className="st-select" aria-label={`${role.label} tier`} value={r.draft!.features[role.id] ?? ""} onChange={(e) => routing.setRole(role.id, e.target.value || null)}>
                      <option value="">{roleEmptyOptionLabel(role.id)}</option>
                      {r.draft!.features[role.id] && !(r.draft!.features[role.id]! in r.draft!.tiers) ? <option value={r.draft!.features[role.id]}>{`${[...TIERS, ...EXTRA_TIERS].find((t) => t.id === r.draft!.features[role.id])?.label ?? r.draft!.features[role.id]} (not set)`}</option> : null}
                      {(role.id === "decisions" ? EXTRA_TIERS.filter((t) => t.id === "decision") : TIERS).filter((t) => t.id in r.draft!.tiers).map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                    </select>
                  </td>
                  <td className="st-hint">{roleStatusText(role.id, r.draft!) ?? tierStatusText(r.loaded?.featureStatus[role.id])}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="st-row">
            <Button tone="primary" disabled={!dirty || r.saving} onClick={() => void routing.save()}>Save routing</Button>
            <Button disabled={!dirty || r.saving} onClick={() => routing.revert()}>Revert</Button>
            {dirty ? <span className="st-hint">Unsaved changes. Saving replaces your whole routing table.</span> : null}
          </div>
        </>
      ) : null}

      <h3 className="st-label">Fallback and limits</h3>
      {!p.catalog && p.error ? (
        <div className="st-row">
          <ErrorText text={`Couldn't load the provider settings: ${p.error}`} />
          <Button onClick={() => void providers.load()}>Retry</Button>
        </div>
      ) : !p.catalog ? (
        <p className="st-hint" role="status">Loading provider settings...</p>
      ) : rows.length === 0 || !settings ? (
        <p className="st-hint">{SWITCH_TEXT.noConnections}</p>
      ) : (
        <>
          <Switch label="Allow tools on provider models" checked={settings.toolsEnabled} hint={SWITCH_TEXT.tools} onChange={(v) => void providers.saveSettings({ toolsEnabled: v })} />
          <Switch label="Let these models fetch URLs and search the web without asking" checked={settings.egressAutoApprove} hint={SWITCH_TEXT.egress} onChange={(v) => void providers.saveSettings({ egressAutoApprove: v })} />
          <Switch label="Fall back to the next provider when one is rate-limited" checked={settings.fallbackEnabled} hint={SWITCH_TEXT.fallback} onChange={(v) => void providers.saveSettings({ fallbackEnabled: v })} />
          {settings.fallbackEnabled ? <FallbackOrder settings={settings} onSave={(order) => void providers.saveSettings({ fallbackOrder: order })} rows={rows.map((x) => ({ provider: x.provider, name: x.name }))} /> : null}
        </>
      )}
      <RoutePrefs getPrefs={host.getRoutePrefs?.bind(host)} setPrefs={host.setRoutePrefs?.bind(host)} migration={p.catalog?.migration} toolsOn={settings?.toolsEnabled} />
      <ExtraPrefs host={host} />
    </div>
  );
}

/** A tier's Model cell: a select of the provider's models, plus a text box for "Other" or when the list cannot load. */
function ModelCell({ label, tier, choice, entry, onChange, onRetry }: { label: string; tier: string; choice: TierChoice | undefined; entry: ModelListEntry | undefined; onChange: (c: TierChoice) => void; onRetry: () => void }) {
  // "Other (type an id)" and typing in the box are remembered per tier and provider, so a typed id that equals a
  // listed one does not close the box mid-typing; changing the provider closes it again.
  const [other, setOther] = useState<string | null>(null);
  if (!choice) return <input className="st-input" aria-label={label} value="" disabled readOnly />;
  const pin = `${tier}|${choice.provider}`;
  const view = pickerView(entry, choice.model, other === pin);
  const text = (
    <input
      className="st-input"
      aria-label={view.kind === "select" ? `${label} (typed id)` : label}
      value={choice.model}
      placeholder="Model id"
      autoComplete="off"
      spellCheck={false}
      onChange={(e) => {
        setOther(pin);
        onChange({ provider: choice.provider, model: e.target.value });
      }}
    />
  );
  if (view.kind === "loading") {
    return (
      <div className="st-stack">
        {text}
        <span className="st-hint" role="status">Loading models...</span>
      </div>
    );
  }
  if (view.kind === "text") {
    return (
      <div className="st-stack">
        {text}
        <span className="st-hint">{view.retry ? `Could not list models${view.note ? `: ${view.note}` : ""}. Type a model id.` : `${view.note} Type a model id.`}</span>
        {view.retry ? <Button label={`Try again to list ${label}`} onClick={onRetry}>Try again</Button> : null}
      </div>
    );
  }
  return (
    <div className="st-stack">
      <select
        className="st-select"
        aria-label={label}
        value={view.value}
        onChange={(e) => {
          if (e.target.value === OTHER_MODEL) {
            setOther(pin);
            return;
          }
          setOther(null);
          onChange({ provider: choice.provider, model: e.target.value });
        }}
      >
        <option value="">Choose a model</option>
        {view.options.map((o) => <option key={o.id} value={o.id}>{o.name === o.id ? o.id : `${o.name} (${o.id})`}</option>)}
        <option value={OTHER_MODEL}>Other (type an id)...</option>
      </select>
      {view.showText ? text : null}
    </div>
  );
}

function FallbackOrder({ settings, rows, onSave }: { settings: ProviderSettings; rows: { provider: string; name: string }[]; onSave: (o: ProviderSettings["fallbackOrder"]) => void }) {
  const connected = new Set(rows.map((x) => x.provider));
  const order = cleanFallback(settings.fallbackOrder, connected);
  const inOrder = new Set(order.map((e) => e.provider));
  const move = (i: number, d: number) => {
    const next = order.slice();
    const j = i + d;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j]!, next[i]!];
    onSave(next);
  };
  const nameOf = (id: string) => rows.find((x) => x.provider === id)?.name ?? id;
  return (
    <div className="st-stack" role="group" aria-label="Fallback order">
      <span className="st-label">Fallback order</span>
      <ol>
        {order.map((e, i) => (
          <li key={`${e.provider}/${e.model ?? ""}`} className="st-row">
            <span className="st-grow">{nameOf(e.provider)}{e.model ? ` (${e.model})` : ""}</span>
            <Button label={`Move ${nameOf(e.provider)} up`} disabled={i === 0} onClick={() => move(i, -1)}>Up</Button>
            <Button label={`Move ${nameOf(e.provider)} down`} disabled={i === order.length - 1} onClick={() => move(i, 1)}>Down</Button>
            <Button label={`Remove ${nameOf(e.provider)} from the fallback order`} onClick={() => onSave(order.filter((_, k) => k !== i))}>Remove</Button>
          </li>
        ))}
      </ol>
      {rows.filter((x) => !inOrder.has(x.provider)).map((x) => (
        <Button key={x.provider} label={`Add ${x.name} to the fallback order`} onClick={() => onSave([...order, { provider: x.provider }])}>Add {x.name}</Button>
      ))}
    </div>
  );
}

function RoutePrefs({ getPrefs, setPrefs, migration, toolsOn }: { getPrefs: (() => Promise<{ router: boolean; cap: boolean }>) | undefined; setPrefs: ((p: { router: boolean; cap: boolean }) => Promise<void>) | undefined; migration: CatalogMigration | undefined; toolsOn: boolean | undefined }) {
  const [prefs, setLocal] = useState<{ router: boolean; cap: boolean } | null>(null);
  useEffect(() => {
    let live = true;
    void getPrefs?.().then((p) => { if (live) setLocal(p); });
    return () => { live = false; };
  }, [getPrefs]);
  const save = (next: { router: boolean; cap: boolean }) => { setLocal(next); void setPrefs?.(next); };
  const notice = (
    <MigrationNotice
      migration={migration}
      toolsOn={toolsOn}
      routerState={prefs ? (prefs.router ? "on" : "off") : "unknown"}
      onTurnOnRouter={setPrefs && prefs ? () => save({ router: true, cap: prefs.cap }) : undefined}
    />
  );
  if (!getPrefs || !setPrefs) return <>{notice}<NeedsHost what="The per-chat model and token limit switches" /></>;
  if (!prefs) return notice;
  return (
    <>
      {notice}
      <Switch label="Per-chat model and token limit (beta)" checked={prefs.router} hint={SWITCH_TEXT.router} onChange={(v) => save({ router: v, cap: v ? prefs.cap : false })} />
      {prefs.router ? <Switch label="Enforce the token limit" checked={prefs.cap} hint={SWITCH_TEXT.cap} onChange={(v) => save({ ...prefs, cap: v })} /> : null}
    </>
  );
}

/** The one-time key carry-over: what was added, what needs review, and the session router the catalog chat needs. */
export function MigrationNotice({ migration, toolsOn, routerState, onTurnOnRouter }: { migration: CatalogMigration | undefined; toolsOn: boolean | undefined; routerState: "on" | "off" | "unknown"; onTurnOnRouter: (() => void) | undefined }) {
  if (!migration || (migration.created.length === 0 && migration.needsReview.length === 0)) return null;
  const created = migration.created.map((c) => c.name);
  return (
    <div className="st-stack" role="group" aria-label="Provider upgrade">
      {created.length > 0 ? <p className="st-hint">{MIGRATION_TEXT.created(created)}</p> : null}
      {migration.needsReview.map((r) => <StatusBanner key={r.provider} severity="warning" message={MIGRATION_TEXT.review(r.name, r.reason)} />)}
      {created.length > 0 && migration.toolsSuggested && toolsOn === false ? <p className="st-hint">{MIGRATION_TEXT.tools}</p> : null}
      {created.length > 0 && routerState === "on" ? <p className="st-hint">{MIGRATION_TEXT.routerPending}</p> : null}
      {created.length > 0 && routerState === "off" ? (
        <div className="st-row">
          <p className="st-hint st-grow">{MIGRATION_TEXT.routerNeeded}</p>
          {onTurnOnRouter ? <Button tone="primary" onClick={onTurnOnRouter}>{MIGRATION_TEXT.routerButton}</Button> : null}
        </div>
      ) : null}
    </div>
  );
}

function ExtraPrefs({ host }: { host: SettingsHost }) {
  const { getExtraPrefs, setExtraPrefs, getRoutePrefs } = host;
  const [prefs, setLocal] = useState<{ compress: boolean; learn: boolean; terminal: boolean; continueSummary: boolean } | null>(null);
  const [router, setRouter] = useState(false);
  useEffect(() => {
    let live = true;
    void getExtraPrefs?.().then((p) => { if (live) setLocal(p); });
    void getRoutePrefs?.().then((p) => { if (live) setRouter(p.router); });
    return () => { live = false; };
  }, [getExtraPrefs, getRoutePrefs]);
  if (!getExtraPrefs || !setExtraPrefs) return null; // the router block above already shows the host placeholder
  if (!prefs) return null;
  const save = (patch: Partial<typeof prefs>) => { setLocal({ ...prefs, ...patch }); void setExtraPrefs(patch); };
  return (
    <>
      {router ? <Switch label="Shorten long prompts (beta)" checked={prefs.compress} hint={SWITCH_TEXT.compress} onChange={(v) => save({ compress: v })} /> : null}
      <Switch label="Learn provider limits (beta)" checked={prefs.learn} hint={SWITCH_TEXT.learn} onChange={(v) => save({ learn: v })} />
      <Switch label="Continue ended chats from a summary (beta)" checked={prefs.continueSummary} hint={SWITCH_TEXT.continueSummary} onChange={(v) => save({ continueSummary: v })} />
    </>
  );
}
