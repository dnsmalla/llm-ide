// Plugins, LLM Sources and MCP Plugins panes of the Library: a windowed list with an on/off switch per row and the
// two consent gates (plugin hook trust, MCP server consent). Add, remove, import and update dialogs are parity rows.
import { useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import type { ExtCore } from "./api.ts";
import { createLegacyApi, LegacyModel, type LegacyApi, type LegacyKind, type LegacyRow, type LegacyState, type LlmSourceRow, type McpRow, type PluginRow } from "./legacy.ts";
import { browseWindow, BROWSE_ROW_HEIGHT } from "./list-model.ts";
import { consentRuns, consentTitle } from "./presentation.ts";
import { Badge, Modal } from "./ui.tsx";
import { useScroller } from "../use-library.ts";

const TITLES: Record<LegacyKind, { title: string; empty: string; intro: string }> = {
  plugins: { title: "Plugins", empty: "No plugins are installed.", intro: "Claude-format plugins found in the plugin folder. Hooks need their own trust before they run." },
  "llm-sources": { title: "LLM Sources", empty: "No LLM sources are registered.", intro: "Skill, agent and command sources the assistant can use." },
  "mcp-plugins": { title: "MCP Plugins", empty: "No MCP servers are registered.", intro: "A server runs only after you consent to it and switch it on." },
};

function rowMeta(kind: LegacyKind, r: LegacyRow): string {
  if (kind === "plugins") {
    const p = r as PluginRow;
    return [p.version ? `v${p.version}` : null, p.author, `${p.skillCount} skills`, p.mcpServerCount > 0 ? `${p.mcpServerCount} MCP servers` : null].filter(Boolean).join(" · ");
  }
  if (kind === "llm-sources") {
    const s = r as LlmSourceRow;
    return [s.origin, s.version ? `v${s.version}` : null, `${s.skillCount} skills`, `${s.agentCount} agents`, `${s.commandCount} commands`, s.disabledItemCount > 0 ? `${s.disabledItemCount} items off` : null].filter(Boolean).join(" · ");
  }
  const m = r as McpRow;
  return [m.source, m.transport, m.runs].filter(Boolean).join(" · ");
}

function Row({ model, kind, row, busy, index, total }: { model: LegacyModel; kind: LegacyKind; row: LegacyRow; busy: boolean; index: number; total: number }): ReactNode {
  const name = kind === "plugins" ? (row as PluginRow).displayName : (row as { name: string }).name;
  const enabled = (row as { enabled: boolean }).enabled;
  const id = `ext-leg-${kind}-${row.id}`;
  const p = kind === "plugins" ? (row as PluginRow) : null;
  const m = kind === "mcp-plugins" ? (row as McpRow) : null;
  const hasHooks = !!p && (p.hookCount > 0 || p.declaresHooks || p.executableKinds.length > 0);
  return (
    <div role="listitem" className="ext-entry" style={{ top: index * BROWSE_ROW_HEIGHT, height: BROWSE_ROW_HEIGHT }} aria-posinset={index + 1} aria-setsize={total}>
      <div className="ext-entry-main">
        <span className="ext-row-name">{name}</span>
        <span className="ext-row-meta">{rowMeta(kind, row)}</span>
        <span className="ext-badges">
          {p && hasHooks && <Badge tone="warn">{p.hooksTrusted ? "Hooks trusted" : p.trustOutdated ? "Hook trust outdated" : "Hooks not trusted"}</Badge>}
          {m && <Badge tone={m.consented ? "ok" : "neutral"}>{m.consented ? "Consented" : "No consent yet"}</Badge>}
          {m?.credentialMissing && <Badge tone="warn">Credential missing</Badge>}
          {m && enabled && m.effective === false && <Badge tone="warn">Not loaded in chats</Badge>}
        </span>
      </div>
      <div className="ext-entry-act">
        {p && hasHooks && !p.hooksTrusted && (
          <button type="button" className="lib-btn" disabled={busy} onClick={() => model.requestHookTrust(p.name)} aria-label={`Review and trust hooks of ${name}`}>
            Review hooks
          </button>
        )}
        {p && p.hooksTrusted && (
          <button type="button" className="lib-btn" disabled={busy} onClick={() => void model.revokeHookTrust(p.name)} aria-label={`Revoke hook trust of ${name}`}>
            Revoke trust
          </button>
        )}
        {m?.consented && (
          <button type="button" className="lib-btn" disabled={busy} onClick={() => void model.revokeMcpConsent(m.id)} aria-label={`Revoke consent of ${name}`}>
            Revoke consent
          </button>
        )}
        <input id={id} type="checkbox" role="switch" aria-checked={enabled} checked={enabled} disabled={busy} onChange={(e) => void model.setEnabled(row.id, e.target.checked)} />
        <label htmlFor={id}>
          <span className="ext-sr">{name}: </span>
          {enabled ? "On" : "Off"}
        </label>
      </div>
    </div>
  );
}

function LegacySheetView({ model, state }: { model: LegacyModel; state: LegacyState }): ReactNode {
  const sh = state.sheet;
  if (!sh) return null;
  const footer = (label: string): ReactNode => (
    <>
      <button type="button" className="lib-btn" onClick={() => model.dismissSheet()}>
        Cancel
      </button>
      <button type="button" className="lib-btn lib-btn-primary" disabled={!model.canConfirm} aria-disabled={!model.canConfirm} onClick={() => void model.confirm()}>
        {label}
      </button>
    </>
  );
  if (sh.kind === "mcp") {
    return (
      <Modal titleId="ext-leg-title" title={`Allow ${sh.label} to run?`} onClose={() => model.dismissSheet()} footer={footer("Allow and switch on")}>
        <p>This MCP server can start or connect and the assistant can call its tools. It {sh.transport === "stdio" ? "runs this command on your machine" : "connects to this address"}:</p>
        <p>
          <code className="ext-commit">{sh.runs || "(no command shown)"}</code>
        </p>
        <div className="ext-consent-line">
          <input id="ext-leg-mcp-tick" type="checkbox" checked={sh.ticked} onChange={(e) => model.tickMcp(e.target.checked)} />
          <label htmlFor="ext-leg-mcp-tick">I allow {sh.label} to run as shown above.</label>
        </div>
      </Modal>
    );
  }
  return (
    <Modal titleId="ext-leg-title" title={`Trust the hooks of ${sh.label}?`} onClose={() => model.dismissSheet()} footer={footer("Trust hooks")}>
      <p>Trusting lets these kinds of code from this plugin run shell commands on your machine during a turn. Tick each one to continue. Enabling the plugin never grants this by itself.</p>
      <ul className="ext-consent-list" aria-label="Kinds of code that would run">
        {sh.kinds.map((k) => {
          const id = `ext-leg-hook-${k}`;
          return (
            <li key={k} className="ext-consent-line">
              <input id={id} type="checkbox" checked={sh.ticked.includes(k)} onChange={(e) => model.tickKind(k, e.target.checked)} />
              <label htmlFor={id}>
                <strong>{consentTitle(k)}</strong>
                <span className="lib-muted ext-block">{consentRuns(k)}</span>
              </label>
            </li>
          );
        })}
      </ul>
      {sh.notes.length > 0 && (
        <ul aria-label="Notes">
          {sh.notes.map((n, i) => (
            <li key={i} className="lib-muted">
              {n}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

export function LegacyView({ model, initialHeight }: { model: LegacyModel; initialHeight?: number }): ReactNode {
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const ref = useRef<HTMLDivElement>(null);
  const { scrollTop, height } = useScroller(ref, initialHeight ?? 520);
  const t = TITLES[model.kind];
  const w = browseWindow(state.rows.length, scrollTop, height);
  return (
    <div className="ext-root ext-legacy" aria-busy={state.loading}>
      <header className="ext-head">
        <h2 className="ext-title">{t.title}</h2>
        <span className="lib-count">{state.loaded ? state.rows.length.toLocaleString() : ""}</span>
        <button type="button" className="lib-btn" disabled={state.loading} onClick={() => void model.load()}>
          Reload list
        </button>
      </header>
      <p className="lib-muted">{t.intro}</p>
      {state.notice && <StatusBanner severity={state.notice.error ? "error" : "info"} message={state.notice.text} onDismiss={() => model.dismissNotice()} />}
      {state.error && (
        <div role="alert" className="ext-inline-error">
          {state.error}
        </div>
      )}
      {!state.loaded && !state.error ? (
        <p className="lib-empty" role="status">
          Loading…
        </p>
      ) : state.loaded && state.rows.length === 0 ? (
        <p className="lib-empty" role="status">
          {t.empty}
        </p>
      ) : (
        <div ref={ref} className="lib-scroll ext-list" role="list" aria-label={t.title} tabIndex={0}>
          <div style={{ height: state.rows.length * BROWSE_ROW_HEIGHT, position: "relative" }}>
            {state.rows.slice(w.start, w.end).map((r, i) => (
              <Row key={r.id} model={model} kind={model.kind} row={r} busy={state.busy.includes(r.id)} index={w.start + i} total={state.rows.length} />
            ))}
          </div>
        </div>
      )}
      <LegacySheetView model={model} state={state} />
    </div>
  );
}

export function LegacyScreen({ api, kind, initialHeight }: { api: LegacyApi; kind: LegacyKind; initialHeight?: number }): ReactNode {
  const model = useMemo(() => new LegacyModel(api, kind), [api, kind]);
  useEffect(() => {
    void model.load();
    return () => model.dispose();
  }, [model]);
  return <LegacyView model={model} initialHeight={initialHeight} />;
}

export { createLegacyApi };
export type { ExtCore };
