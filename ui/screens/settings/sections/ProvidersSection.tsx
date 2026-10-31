import { useMemo, useState } from "react";
import { SettingsSectionCard, RefreshIcon, PlusIcon, StatusBanner } from "@llmide/ui-kit";
import { sharedProvidersModel, useEnv, useModel, useRefreshOnFocus, useStore } from "../context.tsx";
import { ProvidersApi, ProvidersModel, addChoices, contextText, newConnectForm, rowDetail, sortModels, toolsBadge, overrideKey, type ConnectForm, type ProviderRow } from "../providers-model.ts";
import { keyStatusLabel } from "../secret-field.ts";
import { describeError } from "../errors.ts";
import { filterBy } from "../virtual.ts";
import type { ModelList } from "../decoders.ts";
import { Button, ErrorText, Field, SecretInput, Switch, VirtualList } from "../ui.tsx";

export default function ProvidersSection() {
  const { client } = useEnv();
  const model = sharedProvidersModel(client);
  const s = useStore(model);
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [modelsFor, setModelsFor] = useState<ProviderRow | null>(null);
  const [typed, setTyped] = useState("");
  useRefreshOnFocus(() => void model.load());

  const rows = useMemo(() => filterBy(s.rows, query, (r) => `${r.name} ${r.baseURL} ${r.catalogId}`), [s.rows, query]);

  return (
    <div className="st-stack">
      <div className="st-row">
        <input className="st-input st-grow" type="search" aria-label="Filter connections" placeholder="Filter connections" value={query} onChange={(e) => setQuery(e.target.value)} />
        <Button label="Reload connections" onClick={() => void model.load()} disabled={s.phase === "loading"}><RefreshIcon /> Reload</Button>
        <Button tone="primary" onClick={() => setAdding(!adding)}><PlusIcon /> Add from catalog</Button>
      </div>
      <ErrorText text={s.error} />
      {adding && s.catalog ? <AddPanel model={model} onDone={() => setAdding(false)} /> : null}
      {s.pendingRemove ? (
        <div className="st-dialog" role="alertdialog" aria-label={`Remove ${s.pendingRemove.name}`}>
          <strong>Remove {s.pendingRemove.name}?</strong>
          <p>This deletes the connection and its stored key from this computer. Chats that used it fall back to your default model. It cannot be undone; you can connect it again with a new key.</p>
          <Field label={`Type the name "${s.pendingRemove.name}" to confirm`}>
            <input className="st-input" value={typed} autoComplete="off" spellCheck={false} onChange={(e) => setTyped(e.target.value)} />
          </Field>
          <div className="st-row">
            <Button tone="danger" disabled={!ProvidersModel.confirmMatches(s.pendingRemove, typed)} onClick={() => { void model.confirmRemove(typed); setTyped(""); }}>Remove connection</Button>
            <Button onClick={() => { model.cancelRemove(); setTyped(""); }}>Cancel</Button>
          </div>
        </div>
      ) : null}
      {s.phase === "loading" ? <p className="st-hint" role="status">Loading connections...</p> : null}
      {s.phase === "ready" && s.rows.length === 0 ? <p className="st-hint">No connections yet. Choose Add from catalog to connect a provider.</p> : null}
      {rows.length > 0 ? (
        <VirtualList
          items={rows}
          rowHeight={60}
          label="Provider connections"
          keyOf={(r) => r.id}
          render={(r) => {
            const t = s.testResults[r.id];
            const busy = s.busy.has(r.id);
            return (
              <>
                <div className="st-item-text">
                  <strong>{r.name}</strong>
                  <span className="st-hint">{r.kindLabel} · {rowDetail(r)}</span>
                  {t ? <span className={t.ok ? "st-ok" : "st-error"} title={t.detail || undefined}>{t.summary}</span> : null}
                </div>
                <span className="st-status" data-tone={r.hasKey || !r.keyRequired ? "ok" : "warning"}>{keyStatusLabel(r.hasKey, r.keyRequired)}</span>
                <Button label={`Test ${r.name}`} disabled={busy} onClick={() => void model.test(r)}>Test</Button>
                <Button label={`Models of ${r.name}`} onClick={() => setModelsFor(r)}>Models</Button>
                <input type="checkbox" role="switch" aria-label={`Enable ${r.name}`} aria-checked={r.enabled} checked={r.enabled} disabled={busy} onChange={(e) => void model.setEnabled(r, e.target.checked)} />
                <Button tone="danger" label={`Remove ${r.name}`} disabled={busy} onClick={() => model.requestRemove(r)}>Remove</Button>
              </>
            );
          }}
        />
      ) : null}
      {s.rows.length > 0 && rows.length === 0 ? <p className="st-hint">No connection matches that filter.</p> : null}
      {modelsFor ? (
        <SettingsSectionCard icon={<PlusIcon />} title={`Models of ${modelsFor.name}`} defaultExpanded>
          <ModelsPanel row={modelsFor} onClose={() => setModelsFor(null)} />
        </SettingsSectionCard>
      ) : null}
    </div>
  );
}

function AddPanel({ model, onDone }: { model: ProvidersModel; onDone: () => void }) {
  const s = useStore(model);
  const choices = useMemo(() => (s.catalog ? addChoices(s.catalog) : []), [s.catalog]);
  const [choiceId, setChoiceId] = useState(choices[0]?.id ?? "");
  const [form, setForm] = useState<ConnectForm>(() => newConnectForm(choices[0]?.id ?? ""));
  const [resetKey, setResetKey] = useState(0);
  const [, force] = useState(0);
  const choice = choices.find((c) => c.id === choiceId);
  const provider = s.catalog?.providers.find((p) => p.id === choiceId);
  const pick = (id: string) => {
    form.apiKey.clear();
    setChoiceId(id);
    setForm(newConnectForm(id));
    setResetKey((k) => k + 1);
  };
  const patch = (p: Partial<Omit<ConnectForm, "apiKey">>) => {
    Object.assign(form, p);
    force((n) => n + 1);
  };
  return (
    <div className="st-stack" role="group" aria-label="Add a provider connection">
      <Field label="Provider">
        <select className="st-select" value={choiceId} onChange={(e) => pick(e.target.value)}>
          {choices.map((c) => (
            <option key={c.id} value={c.id} disabled={!c.available}>{c.name} ({c.kindLabel}){c.available ? "" : " - not available yet"}</option>
          ))}
        </select>
      </Field>
      {choice && !choice.available ? <StatusBanner severity="info" message={choice.unavailableReason ?? "Not available."} /> : null}
      {provider ? (
        <>
          {provider.notes ? <p className="st-hint">{provider.notes}</p> : null}
          {provider.keyRequired ? <SecretInput label="API key" field={form.apiKey} resetKey={resetKey} hint="Stored in the secure vault on this computer. It is never shown again." /> : null}
          {provider.customBaseURL || provider.local ? (
            <Field label="Address" hint="The full address, for example https://gateway.example.com/v1">
              <input className="st-input" value={form.baseURL} onChange={(e) => patch({ baseURL: e.target.value })} autoComplete="off" spellCheck={false} />
            </Field>
          ) : null}
          {provider.customBaseURL ? (
            <>
              <Field label="Name"><input className="st-input" value={form.name} onChange={(e) => patch({ name: e.target.value })} /></Field>
              <Field label="Short name" hint="1 to 24 lowercase letters or digits. Needed to add a second endpoint.">
                <input className="st-input" value={form.slug} onChange={(e) => patch({ slug: e.target.value })} />
              </Field>
            </>
          ) : null}
          {provider.allowPrivate ? (
            <Switch label="This address is on my own network (allow a private-network address)" checked={form.allowPrivate} onChange={(v) => patch({ allowPrivate: v })} />
          ) : null}
          {["openai", "google", "deepseek"].includes(provider.id) ? (
            <Switch label="Copy the key I already stored for this provider" checked={form.copyKey} onChange={(v) => patch({ copyKey: v })} hint="The older key stays where it is; nothing is shown." />
          ) : null}
          <div className="st-row">
            <Button
              tone="primary"
              disabled={s.adding}
              onClick={() => {
                void model.connect(provider, form).then((ok) => {
                  setResetKey((k) => k + 1);
                  if (ok) onDone();
                });
              }}
            >
              Connect
            </Button>
            <Button onClick={() => { form.apiKey.clear(); onDone(); }}>Cancel</Button>
          </div>
        </>
      ) : null}
    </div>
  );
}

function ModelsPanel({ row, onClose }: { row: ProviderRow; onClose: () => void }) {
  const { client } = useEnv();
  const providers = sharedProvidersModel(client);
  const ps = useStore(providers);
  const api = useModel(() => new ProvidersApi(client));
  const [list, setList] = useState<ModelList | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const overrides = ps.catalog?.settings.toolOverrides ?? {};
  const load = (refresh: boolean) => {
    setLoading(true);
    api.models(row.id, refresh).then((l) => { setList(l); setErr(null); }, (e) => setErr(describeError(e))).finally(() => setLoading(false));
  };
  useRefreshOnFocus(() => { if (!list && !loading) load(false); });
  const models = useMemo(() => sortModels(list?.models ?? []), [list]);
  return (
    <div className="st-stack">
      <div className="st-row">
        <Button onClick={() => load(true)} disabled={loading}>Refresh list</Button>
        <Button onClick={onClose}>Close</Button>
      </div>
      <ErrorText text={err} />
      {list?.source === "static" ? <p className="st-hint">Showing the built-in list: no key was available or the provider could not be reached.</p> : null}
      <VirtualList
        items={models}
        rowHeight={48}
        label={`Models of ${row.name}`}
        keyOf={(m) => m.id}
        render={(m) => {
          const k = overrideKey(row.id, m.id);
          const on = k in overrides ? overrides[k]! : m.toolsSupported;
          const badge = toolsBadge(m);
          return (
            <>
              <div className="st-item-text">
                <strong>{m.id}</strong>
                <span className="st-hint">{[badge, contextText(m), m.streaming ? "streams" : null].filter(Boolean).join(" · ") || "No capability information"}</span>
              </div>
              <label className="st-row">
                <input type="checkbox" role="switch" aria-label={`Use tools with ${m.id}`} checked={on} onChange={(e) => void providers.saveSettings({ toolOverrides: { ...overrides, [k]: e.target.checked } })} />
                <span className="st-hint">Tools</span>
              </label>
            </>
          );
        }}
      />
    </div>
  );
}
