// Plugins, LLM Sources and MCP Plugins panes of the Library: a windowed list with an on/off switch per row, the
// two consent gates (plugin hook trust, MCP server consent), read-only status badges and a detail pane per row.
// Add, remove, import and apply-update dialogs are parity rows.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import type { ExtCore } from "./api.ts";
import { createLegacyApi, filterRows, LegacyModel, RELOAD_BUSY, type ClaudePluginRow, type LegacyApi, type LegacyKind, type LegacyRow, type LegacyState, type LlmSourceRow, type McpRow, type PluginRow } from "./legacy.ts";
import { LegacyDetail } from "./LegacyDetail.tsx";
import { mcpSourceBadge, type LocationReveal } from "./legacy-labels.ts";
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
  return [mcpSourceBadge(m.source), m.transport, m.versionLabel, m.runs].filter(Boolean).join(" · ");
}

function Row({ model, kind, row, state, index, total }: { model: LegacyModel; kind: LegacyKind; row: LegacyRow; state: LegacyState; index: number; total: number }): ReactNode {
  const busy = state.busy.includes(row.id);
  const selected = state.selected === row.id;
  const name = kind === "plugins" ? (row as PluginRow).displayName : (row as { name: string }).name;
  const enabled = (row as { enabled: boolean }).enabled;
  const id = `ext-leg-${kind}-${row.id}`;
  const p = kind === "plugins" ? (row as PluginRow) : null;
  const m = kind === "mcp-plugins" ? (row as McpRow) : null;
  const src = kind === "llm-sources" ? (row as LlmSourceRow) : null;
  const hasHooks = !!p && (p.hookCount > 0 || p.declaresHooks || p.executableKinds.length > 0);
  const sourceUpdate = src ? state.sourceUpdates[row.id] : undefined;
  const mcpVersion = m ? state.mcpVersions[m.id] : undefined;
  return (
    <div role="listitem" className="ext-entry" data-selected={selected} style={{ top: index * BROWSE_ROW_HEIGHT, height: BROWSE_ROW_HEIGHT }} aria-posinset={index + 1} aria-setsize={total}>
      <input type="checkbox" className="ext-row-check" checked={state.checked.includes(row.id)} aria-label={`Select ${name}`} onChange={() => model.toggleChecked(row.id)} />
      <div className="ext-entry-main">
        <span className="ext-row-name">{name}</span>
        <span className="ext-row-meta">{rowMeta(kind, row)}</span>
        <span className="ext-badges">
          {p && hasHooks && <Badge tone="warn">{p.hooksTrusted ? "Hooks trusted" : p.trustOutdated ? "Hook trust outdated" : "Hooks not trusted"}</Badge>}
          {p && state.pluginUpdates[p.name] && <Badge tone="accent">Update available</Badge>}
          {m && <Badge tone={m.consented ? "ok" : "neutral"}>{m.consented ? "Consented" : "No consent yet"}</Badge>}
          {m?.credentialMissing && <Badge tone="warn">Credential missing</Badge>}
          {m && enabled && m.effective === false && <Badge tone="warn">Not loaded in chats</Badge>}
          {mcpVersion?.status === "update-available" && <Badge tone="accent" title={`A newer version is available: ${mcpVersion.latest ?? ""}`}>Update</Badge>}
          {src && !src.installed && <Badge>not installed</Badge>}
          {sourceUpdate?.status === "update-available" && <Badge tone="accent" title="A newer version is available: open the source and press Update">update</Badge>}
        </span>
      </div>
      <div className="ext-entry-act">
        <button type="button" className="lib-btn" aria-pressed={selected} aria-label={`Details of ${name}`} onClick={() => model.select(selected ? null : row.id)}>
          Details
        </button>
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
  if (sh.kind === "source-update") {
    // Cancel is the first focusable control, so the dialog opens on it.
    return (
      <Modal titleId="ext-leg-title" title={`Update ${sh.label}?`} onClose={() => model.dismissSheet()} footer={footer("Update")}>
        {sh.builtin ? (
          <>
            <p>Central Skills fast-forwards to the latest kit on its remote branch. Nothing is discarded: the update is refused, and nothing changes, if its folder has uncommitted changes or commits that are not on the remote.</p>
            <p>When the kit is this checkout&apos;s .skills folder and it moved, scripts/sync-skills.sh then re-syncs the kit&apos;s skill lock and agent tool definitions.</p>
          </>
        ) : (
          // Same rules as the core's updateSource: a dirty folder is refused (409) before anything runs; a clean one is
          // moved with git reset --hard FETCH_HEAD, which drops commits that exist only in the folder.
          <p>
            If its folder has uncommitted changes, the update is refused and nothing changes. Otherwise the source is reset to its remote version (origin/{sh.ref ?? "main"}) with git reset --hard, so commits in its folder that are not on the remote are discarded. New items it brings in are switched on.
          </p>
        )}
      </Modal>
    );
  }
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

/** Install a plugin from a public git URL (the server clones and packages it). */
function InstallPluginGitDialog({ model, onClose }: { model: LegacyModel; onClose: () => void }): ReactNode {
  const [url, setUrl] = useState("");
  const [ref, setRef] = useState("");
  const [busy, setBusy] = useState(false);
  const valid = url.trim().startsWith("https://") || url.trim().startsWith("git@");
  return (
    <Modal titleId="plugin-git-title" title="Install plugin from Git URL" onClose={onClose} footer={<><button type="button" className="lib-btn" disabled={busy} onClick={onClose}>Cancel</button><button type="button" className="lib-btn lib-btn-primary" disabled={!valid || busy} onClick={() => { setBusy(true); void model.installPluginGit(url.trim(), ref.trim() || undefined).then((ok) => { if (ok) onClose(); }).finally(() => setBusy(false)); }}>{busy ? "Installing…" : "Install"}</button></>}>
      <div className="ext-form" aria-label="Install plugin from Git URL">
        <p className="lib-muted">Public HTTPS or git@ URL. The server clones it shallowly, packages and validates it before install. The plugin is installed switched off.</p>
        <div className="ext-field"><label htmlFor="plugin-git-url">Git URL</label><input id="plugin-git-url" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/owner/repo" spellCheck={false} /></div>
        <div className="ext-field"><label htmlFor="plugin-git-ref">Branch or tag (optional)</label><input id="plugin-git-ref" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="main" spellCheck={false} /></div>
      </div>
    </Modal>
  );
}

/** Import one plugin already installed in Claude Code (the Mac's ClaudePluginImportSheet, installed tab). */
function ImportClaudeDialog({ model, onClose }: { model: LegacyModel; onClose: () => void }): ReactNode {
  const [tab, setTab] = useState<"installed" | "marketplace">("installed");
  const [installed, setInstalled] = useState<Array<ClaudePluginRow> | null>(null);
  const [marketplace, setMarketplace] = useState<Array<ClaudePluginRow> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  useEffect(() => {
    let live = true;
    void model.claudePlugins().then((r) => { if (live) setInstalled(r); }, (e: unknown) => { if (live) setError(e instanceof Error ? e.message : "Could not scan Claude Code."); });
    void model.claudeMarketplace().then((r) => { if (live) setMarketplace(r); }, () => { if (live) setMarketplace([]); });
    return () => { live = false; };
  }, [model]);
  const rows = tab === "installed" ? installed : marketplace;
  const shown = (rows ?? []).filter((r) => !query.trim() || r.name.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <Modal titleId="claude-import-title" title="Import from Claude Code" onClose={onClose} footer={<button type="button" className="lib-btn" onClick={onClose}>Done</button>}>
      <div className="ext-form" aria-label="Claude Code plugins">
        <div role="tablist" aria-label="Claude plugin source" className="ext-tabs">
          <button type="button" role="tab" aria-selected={tab === "installed"} className="ext-tab" data-selected={tab === "installed"} onClick={() => setTab("installed")}>Installed in Claude</button>
          <button type="button" role="tab" aria-selected={tab === "marketplace"} className="ext-tab" data-selected={tab === "marketplace"} onClick={() => setTab("marketplace")}>Marketplace</button>
        </div>
        <p className="lib-muted">{tab === "installed" ? "Plugins installed in Claude Code. Import copies one into LLM-IDE; it stays switched off until you enable it." : "Plugins from the Claude marketplace. Import copies one into LLM-IDE; it stays switched off until you enable it."}</p>
        <input className="chat-input" type="search" aria-label="Filter Claude plugins" placeholder="Filter plugins…" value={query} onChange={(e) => setQuery(e.target.value)} />
        {rows === null && !error ? <p className="lib-muted" role="status">{tab === "installed" ? "Scanning Claude Code…" : "Loading the marketplace…"}</p> : null}
        {error ? <p role="alert" className="ext-inline-error">{error}</p> : null}
        {rows !== null && shown.length === 0 ? <p className="lib-muted">{rows.length === 0 ? "No Claude plugins found." : "No plugins match."}</p> : null}
        <ul className="ext-members" aria-label="Claude plugins">
          {shown.map((r) => (
            <li key={`${tab}:${r.name}`}>
              <span><strong>{r.name}</strong> <span className="lib-muted">{r.version ? `v${r.version}` : ""}{r.skillCount ? ` · ${r.skillCount} skills` : ""}{r.commandCount ? ` · ${r.commandCount} commands` : ""}{r.hasUpdate ? " · update available" : ""}</span></span>
              {r.alreadyImported ? <span className="lib-muted">Imported</span> : <button type="button" className="lib-btn" disabled={busy !== null} onClick={() => { setBusy(r.name); void model.importClaude(r.name, tab).then((ok) => { if (ok) { const mark = (cur: Array<ClaudePluginRow> | null) => cur?.map((x) => x.name === r.name ? { ...x, alreadyImported: true } : x) ?? null; if (tab === "installed") setInstalled(mark); else setMarketplace(mark); } }).finally(() => setBusy(null)); }}>{busy === r.name ? "Importing…" : "Import"}</button>}
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}

function ImportCodexDialog({ model, onClose }: { model: LegacyModel; onClose: () => void }): ReactNode {
  const [rows, setRows] = useState<Array<{ name: string; version: string; skillCount: number; commandCount: number; alreadyImported: boolean; hasUpdate: boolean }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  useEffect(() => {
    let live = true;
    void model.codexPlugins().then((r) => { if (live) setRows(r); }, (e: unknown) => { if (live) setError(e instanceof Error ? e.message : "Could not scan Codex."); });
    return () => { live = false; };
  }, [model]);
  const shown = (rows ?? []).filter((r) => !query.trim() || r.name.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <Modal titleId="codex-import-title" title="Import from Codex" onClose={onClose} footer={<button type="button" className="lib-btn" onClick={onClose}>Done</button>}>
      <div className="ext-form" aria-label="Codex plugins">
        <p className="lib-muted">Plugins installed in Codex. Import copies one into LLM-IDE; it stays switched off until you enable it.</p>
        <input className="chat-input" type="search" aria-label="Filter Claude plugins" placeholder="Filter plugins…" value={query} onChange={(e) => setQuery(e.target.value)} />
        {rows === null && !error ? <p className="lib-muted" role="status">Scanning Codex…</p> : null}
        {error ? <p role="alert" className="ext-inline-error">{error}</p> : null}
        {rows !== null && shown.length === 0 ? <p className="lib-muted">{rows.length === 0 ? "No Codex plugins found." : "No plugins match."}</p> : null}
        <ul className="ext-members" aria-label="Codex plugins">
          {shown.map((r) => (
            <li key={r.name}>
              <span><strong>{r.name}</strong> <span className="lib-muted">{r.version ? `v${r.version}` : ""}{r.skillCount ? ` · ${r.skillCount} skills` : ""}{r.commandCount ? ` · ${r.commandCount} commands` : ""}</span></span>
              {r.alreadyImported ? <span className="lib-muted">Imported</span> : <button type="button" className="lib-btn" disabled={busy !== null} onClick={() => { setBusy(r.name); void model.importCodex(r.name).then((ok) => { if (ok) setRows((cur) => cur?.map((x) => x.name === r.name ? { ...x, alreadyImported: true } : x) ?? null); }).finally(() => setBusy(null)); }}>{busy === r.name ? "Importing…" : "Import"}</button>}
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}

/** Add a public git or local LLM source (the Mac's LlmSourceAddSheet). The core validates the real shape. */
function AddSourceDialog({ model, onClose }: { model: LegacyModel; onClose: () => void }): ReactNode {
  const [mode, setMode] = useState<"git" | "local">("git");
  const [url, setUrl] = useState("");
  const [ref, setRef] = useState("");
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const valid = mode === "git" ? url.trim().startsWith("https://") : path.trim() !== "";
  return (
    <Modal titleId="source-add-title" title="Add LLM source" onClose={onClose} footer={<><button type="button" className="lib-btn" onClick={onClose} disabled={busy}>Cancel</button><button type="button" className="lib-btn lib-btn-primary" disabled={!valid || busy} onClick={() => {
      setBusy(true);
      const body = mode === "git"
        ? { url: url.trim(), ...(ref.trim() ? { ref: ref.trim() } : {}), ...(name.trim() ? { name: name.trim() } : {}) }
        : { path: path.trim(), ...(name.trim() ? { name: name.trim() } : {}) };
      void model.addLlmSource(body).then((ok) => { if (ok) onClose(); }).finally(() => setBusy(false));
    }}>{busy ? "Adding…" : "Add"}</button></>}>
      <div className="ext-form" aria-label="Add LLM source">
        <div className="ext-field"><label htmlFor="source-add-mode">Kind</label><select id="source-add-mode" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}><option value="git">Git URL</option><option value="local">Local path</option></select></div>
        {mode === "git" ? (
          <>
            <div className="ext-field"><label htmlFor="source-add-url">Git URL</label><input id="source-add-url" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/owner/repo" spellCheck={false} /><p className="lib-muted">Public HTTPS URL only. Cloned shallowly on the server.</p></div>
            <div className="ext-field"><label htmlFor="source-add-ref">Branch or tag (optional)</label><input id="source-add-ref" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="main" spellCheck={false} /></div>
          </>
        ) : (
          <div className="ext-field"><label htmlFor="source-add-path">Local path</label><input id="source-add-path" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/path/to/repo" spellCheck={false} /><p className="lib-muted">A directory containing registry.yaml, .claude-plugin/plugin.json + skills/, an agents/ dir, or a hooks manifest.</p></div>
        )}
        <div className="ext-field"><label htmlFor="source-add-name">Name (optional)</label><input id="source-add-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Display name" maxLength={120} /></div>
      </div>
    </Modal>
  );
}

/** Add one hand-written MCP server (the Mac's McpAddSheet manual form). The core stores it switched off. */
function AddMcpDialog({ model, onClose }: { model: LegacyModel; onClose: () => void }): ReactNode {
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"stdio" | "http" | "sse">("stdio");
  const [commandLine, setCommandLine] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const parts = commandLine.split(/\s+/).filter(Boolean);
  const valid = transport === "stdio" ? parts.length > 0 : url.trim() !== "";
  return (
    <Modal titleId="mcp-add-title" title="Add an MCP server" onClose={onClose} footer={<><button type="button" className="lib-btn" onClick={onClose} disabled={busy}>Cancel</button><button type="button" className="lib-btn lib-btn-primary" disabled={!valid || busy} onClick={() => {
      setBusy(true);
      const body = transport === "stdio"
        ? { name: name.trim() || undefined, transport, command: parts[0]!, args: parts.slice(1) }
        : { name: name.trim() || undefined, transport, url: url.trim() };
      void model.addMcp(body).then((ok) => { if (ok) onClose(); }).finally(() => setBusy(false));
    }}>{busy ? "Adding…" : "Add"}</button></>}>
      <div className="ext-form" aria-label="Add an MCP server">
        <div className="ext-field"><label htmlFor="mcp-add-name">Name (optional)</label><input id="mcp-add-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="my-server" maxLength={80} /></div>
        <div className="ext-field"><label htmlFor="mcp-add-transport">Transport</label><select id="mcp-add-transport" value={transport} onChange={(e) => setTransport(e.target.value as typeof transport)}><option value="stdio">Local (stdio)</option><option value="http">Hosted (http)</option><option value="sse">Hosted (sse)</option></select></div>
        {transport === "stdio" ? (
          <div className="ext-field"><label htmlFor="mcp-add-command">Command</label><input id="mcp-add-command" value={commandLine} onChange={(e) => setCommandLine(e.target.value)} placeholder="npx -y @modelcontextprotocol/server-memory" spellCheck={false} /><p className="lib-muted">Split on spaces; the first word is the command and the rest are its arguments.</p></div>
        ) : (
          <div className="ext-field"><label htmlFor="mcp-add-url">URL</label><input id="mcp-add-url" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" spellCheck={false} /></div>
        )}
        <p className="lib-muted">The server is added switched off. You must consent and switch it on before it can run.</p>
      </div>
    </Modal>
  );
}

export function LegacyView({ model, initialHeight, revealer }: { model: LegacyModel; initialHeight?: number; revealer?: LocationReveal }): ReactNode {
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const ref = useRef<HTMLDivElement>(null);
  const { scrollTop, height } = useScroller(ref, initialHeight ?? 520);
  const t = TITLES[model.kind];
  const rows = filterRows(state.rows, state.filter);
  const w = browseWindow(rows.length, scrollTop, height);
  const detail = state.selected !== null;
  const [adding, setAdding] = useState(false);
  const [addingSource, setAddingSource] = useState(false);
  const [importingClaude, setImportingClaude] = useState(false);
  const [importingCodex, setImportingCodex] = useState(false);
  const [installingGit, setInstallingGit] = useState(false);
  return (
    <div className="ext-root ext-legacy" aria-busy={state.loading}>
      <header className="ext-head">
        <h2 className="ext-title">{t.title}</h2>
        <span className="lib-count">{state.loaded ? state.rows.length.toLocaleString() : ""}</span>
        <button type="button" className="lib-btn" disabled={state.loading} onClick={() => void model.load(true)}>
          Reload list
        </button>
        {model.kind === "mcp-plugins" && (
          <button type="button" className="lib-btn" disabled={state.loading} onClick={() => setAdding(true)}>Add server</button>
        )}
        {model.kind === "llm-sources" && (
          <button type="button" className="lib-btn" disabled={state.loading} onClick={() => setAddingSource(true)}>Add source</button>
        )}
        {model.kind === "plugins" && (
          <>
            <button type="button" className="lib-btn" disabled={state.loading} onClick={() => setImportingClaude(true)}>Import from Claude…</button>
            <button type="button" className="lib-btn" disabled={state.loading} onClick={() => setImportingCodex(true)}>Import from Codex…</button>
            <button type="button" className="lib-btn" disabled={state.loading} onClick={() => setInstallingGit(true)}>Install from Git…</button>
          </>
        )}
        {model.kind === "plugins" && (
          <button type="button" className="lib-btn" disabled={state.loading || state.busy.includes(RELOAD_BUSY)} onClick={() => void model.reloadPlugins()}>
            Reload from disk
          </button>
        )}
      </header>
      <p className="lib-muted">{t.intro}</p>
      {adding ? <AddMcpDialog model={model} onClose={() => setAdding(false)} /> : null}
      {addingSource ? <AddSourceDialog model={model} onClose={() => setAddingSource(false)} /> : null}
      {importingClaude ? <ImportClaudeDialog model={model} onClose={() => setImportingClaude(false)} /> : null}
      {importingCodex ? <ImportCodexDialog model={model} onClose={() => setImportingCodex(false)} /> : null}
      {installingGit ? <InstallPluginGitDialog model={model} onClose={() => setInstallingGit(false)} /> : null}
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
      ) : state.loaded && state.rows.length === 0 && !detail ? (
        <p className="lib-empty" role="status">
          {t.empty}
        </p>
      ) : state.loaded && state.rows.length === 0 ? (
        // The open row vanished: its pane says so instead of closing silently.
        <div className="ext-split">
          <div className="ext-split-list" />
          <div className="ext-split-detail">
            <LegacyDetail model={model} state={state} revealer={revealer} />
          </div>
        </div>
      ) : (
        <div className={detail ? "ext-split" : undefined}>
          <div className={detail ? "ext-split-list" : undefined}>
            <LegacySelectionBar model={model} state={state} shown={rows} />
            <div ref={ref} className="lib-scroll ext-list" role="list" aria-label={t.title} tabIndex={0}>
              <div style={{ height: rows.length * BROWSE_ROW_HEIGHT, position: "relative" }}>
                {rows.slice(w.start, w.end).map((r, i) => (
                  <Row key={r.id} model={model} kind={model.kind} row={r} state={state} index={w.start + i} total={rows.length} />
                ))}
              </div>
            </div>
          </div>
          {detail && (
            <div className="ext-split-detail">
              <LegacyDetail model={model} state={state} revealer={revealer} />
            </div>
          )}
        </div>
      )}
      <LegacySheetView model={model} state={state} />
    </div>
  );
}

export function LegacyScreen({ api, kind, initialHeight, revealer }: { api: LegacyApi; kind: LegacyKind; initialHeight?: number; revealer?: LocationReveal }): ReactNode {
  const model = useMemo(() => new LegacyModel(api, kind), [api, kind]);
  useEffect(() => {
    void model.load();
    return () => model.dispose();
  }, [model]);
  return <LegacyView model={model} initialHeight={initialHeight} revealer={revealer} />;
}

export { createLegacyApi };
export type { ExtCore };

/** Above the list: the filter, "select all shown", and the bulk switch for the ticked rows. */
function LegacySelectionBar({ model, state, shown }: { model: LegacyModel; state: LegacyState; shown: readonly LegacyRow[] }): ReactNode {
  const n = state.checked.length;
  const allShown = shown.length > 0 && shown.every((r) => state.checked.includes(r.id));
  const busy = state.busy.length > 0;
  return (
    <div className="ext-selbar">
      <input type="search" className="ext-filter" value={state.filter} placeholder={`Filter ${state.rows.length.toLocaleString()}…`} aria-label={`Filter ${TITLES[model.kind].title}`} onChange={(e) => model.setFilter(e.target.value)} />
      <div className="ext-selbar-row">
        <label className="ext-selall">
          <input type="checkbox" checked={allShown} disabled={shown.length === 0} onChange={() => model.toggleAllShown()} />
          {allShown ? "Clear shown" : shown.length !== state.rows.length ? "Select all shown" : "Select all"}
        </label>
        {n > 0 ? (
          <span className="ext-selbar-actions" role="group" aria-label={`${n} selected`}>
            <span className="ext-selcount">{n} selected</span>
            <button type="button" className="lib-btn lib-btn-primary" disabled={busy} onClick={() => void model.bulkSwitch(true)}>Switch on</button>
            <button type="button" className="lib-btn" disabled={busy} onClick={() => void model.bulkSwitch(false)}>Switch off</button>
            <button type="button" className="lib-btn" onClick={() => model.clearChecked()}>Clear</button>
          </span>
        ) : <span className="lib-muted">Tick several to switch them on or off together.</span>}
      </div>
      {shown.length === 0 ? <p className="lib-muted" role="status">Nothing matches “{state.filter.trim()}”.</p> : null}
    </div>
  );
}
