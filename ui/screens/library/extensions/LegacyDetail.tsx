// Read-only detail panes for the Library's Plugins, MCP Plugins and LLM Sources lists. Everything shown is text
// from the core (plugin and source text is untrusted: rendered as React text only, already cleaned and capped by
// the decoders). The only controls are the source's per-item switches and its Update / Check buttons, which are
// the same calls the list uses. Consent, hook trust and removal stay on the list rows and their sheets.
import { Fragment, type ReactNode } from "react";
import { Badge } from "./ui.tsx";
import type { DiscoveryItem, LegacyKind, LegacyRow, LegacyState, LlmSourceRow, McpRow, PluginRow } from "./legacy.ts";
import type { LegacyModel } from "./legacy.ts";
import { componentRowText, hookTrustState, hooksHeading, installSourceText, mcpSourceLabel, outdatedTrustText, type LocationReveal } from "./legacy-labels.ts";

export { mcpSourceBadge, mcpSourceLabel } from "./legacy-labels.ts";

export const NOT_FOUND: Record<LegacyKind, string> = {
  plugins: "Plugin not found — it may have been uninstalled.",
  "mcp-plugins": "Plugin not found — it may have been removed.",
  "llm-sources": "Source not found — it may have been removed.",
};

export function LegacyDetail({ model, state, revealer }: { model: LegacyModel; state: LegacyState; revealer?: LocationReveal }): ReactNode {
  const id = state.selected;
  if (id === null) return null;
  const row = state.rows.find((r) => r.id === id) as LegacyRow | undefined;
  if (!row) {
    return (
      <div className="ext-detail">
        <p className="lib-empty" role="status">
          {NOT_FOUND[model.kind]}
        </p>
      </div>
    );
  }
  if (model.kind === "plugins") return <PluginDetail state={state} p={row as PluginRow} />;
  if (model.kind === "mcp-plugins") return <McpDetail state={state} m={row as McpRow} />;
  return <SourceDetail model={model} state={state} s={row as LlmSourceRow} revealer={revealer} />;
}

function Facts({ rows }: { rows: readonly [string, string][] }): ReactNode {
  return (
    <dl className="ext-facts">
      {rows.map(([k, v]) => (
        <Fragment key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

function PluginDetail({ state, p }: { state: LegacyState; p: PluginRow }): ReactNode {
  const upd = state.pluginUpdates[p.name];
  const shown = p.sourceVersion || upd?.importedVersion || upd?.claudeVersion || p.version || "";
  const hasHooks = p.hookCount > 0 || p.declaresHooks || p.executableKinds.length > 0;
  const hookState = p.hooksTrusted ? "Hooks trusted" : p.trustOutdated ? "Hook trust outdated" : "Hooks not trusted";
  const imported = p.origin === "claude" || p.origin === "codex";
  const source = installSourceText(p.installSource);
  return (
    <div className="ext-detail" aria-label={`Details of ${p.displayName}`}>
      <div className="ext-detail-head">
        <h2>{p.displayName}</h2>
        <p className="lib-muted">
          {p.version ? `v${p.version}` : "No version"}
          {p.author ? ` · by ${p.author}` : ""}
        </p>
        {source && <p className="lib-muted ext-install-source" title={source}>{source}</p>}
      </div>
      <span className="ext-badges">
        <Badge tone={p.enabled ? "ok" : "neutral"}>{p.enabled ? "On" : "Off"}</Badge>
        {p.origin === "claude" && <Badge tone="accent">Imported from Claude Code</Badge>}
        {p.origin === "codex" && <Badge tone="accent">Imported from Codex</Badge>}
        {hasHooks && <Badge tone="warn">{hookState}</Badge>}
      </span>
      <Facts rows={[["Format", p.format || "unknown"], ["Skills", String(p.skillCount)], ["MCP servers", String(p.mcpServerCount)]]} />
      {p.description && (
        <section>
          <h3>About</h3>
          <p>{p.description}</p>
        </section>
      )}
      <section>
        <h3>Slash commands ({p.commands.length})</h3>
        {p.commands.length === 0 ? (
          <p className="lib-muted">None.</p>
        ) : (
          <ul className="ext-members" aria-label="Slash commands">
            {p.commands.map((c) => (
              <li key={c.trigger}>
                <code>/{c.trigger}</code>
                <span className="lib-muted">{c.description}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {p.subagents.length > 0 && (
        <section>
          <h3>Subagents ({p.subagents.length})</h3>
          <ul className="ext-members" aria-label="Subagents">
            {p.subagents.map((a) => (
              <li key={a.name}>
                <strong>{a.name}</strong>
                <span className="lib-muted">{a.description}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {p.skillCount > 0 && (
        <p className="lib-muted">
          {p.skillCount} {p.skillCount === 1 ? "skill" : "skills"} loaded.
        </p>
      )}
      {(p.unsupportedComponents.length > 0 || p.pendingComponents.length > 0) && (
        <section>
          <h3>Components</h3>
          <ul className="ext-members" aria-label="Components">
            {p.pendingComponents.includes("mcp") && (
              <li className="lib-muted">
                {p.mcpServerCount > 0
                  ? `${p.mcpServerCount} MCP ${p.mcpServerCount === 1 ? "server" : "servers"} declared — consent to each under MCP Plugins to activate`
                  : "MCP servers — declared, none registered"}
              </li>
            )}
            {p.pendingComponents
              .filter((c) => c !== "mcp")
              .map((c) => (
                <li key={`p-${c}`} className="lib-muted">
                  {c} — pending
                </li>
              ))}
            {p.unsupportedComponents.map((c) => (
              <li key={`u-${c}`} className="lib-muted">
                {componentRowText(c, p)}
              </li>
            ))}
          </ul>
        </section>
      )}
      {hasHooks && (
        // Read-only: the state the core reports. Granting or revoking trust stays on the list row and its sheet.
        <section aria-label="Hook trust">
          <h3>{hooksHeading(p)}</h3>
          <Facts rows={[["State", hookTrustState(p)]]} />
          {p.trustOutdated && !p.hooksTrusted && <p>{outdatedTrustText(p)}</p>}
          {!p.enabled && <p className="lib-muted">Enable the plugin first — its hooks and scripts only run for an enabled plugin.</p>}
          {!p.nativeDelivery && p.hookNotes.length > 0 && (
            <ul aria-label="Hook notes">
              {p.hookNotes.map((n, i) => (
                <li key={i} className="lib-muted">
                  {n}
                </li>
              ))}
            </ul>
          )}
          <p className="lib-muted">Trust is granted or revoked from this plugin&apos;s row in the list.</p>
        </section>
      )}
      {imported && (
        <section aria-label="Updates">
          <h3>Updates</h3>
          {state.pluginUpdates[p.name] === undefined && state.statusLoading ? (
            <p className="lib-muted" role="status">
              Checking for updates…
            </p>
          ) : state.statusError && upd === undefined ? (
            <p className="lib-muted">Could not check for updates: {state.statusError}</p>
          ) : upd ? (
            <p>
              Update reported
              {upd.latest ? ` for v${upd.latest}` : ""}.
            </p>
          ) : (
            <p className="lib-muted">No update reported{shown ? ` for v${shown}` : ""}.</p>
          )}
        </section>
      )}
    </div>
  );
}

function McpDetail({ state, m }: { state: LegacyState; m: McpRow }): ReactNode {
  const v = state.mcpVersions[m.id];
  const label = m.transport === "stdio" ? "Command" : "URL";
  // Names only, never values: env and header values stay on the server (the list answer redacts them).
  const facts: [string, string][] = [
    [label, m.runs || "none"],
    ["Transport", m.transport || "unknown"],
  ];
  if (m.envKeys.length > 0) facts.push(["Environment", m.envKeys.join(", ")]);
  if (m.headerKeys.length > 0) facts.push(["Headers", m.headerKeys.join(", ")]);
  if (m.hasCredential) facts.push(["Credential", m.credentialMissing ? "not set" : "set"]);
  return (
    <div className="ext-detail" aria-label={`Details of ${m.name}`}>
      <div className="ext-detail-head">
        <h2>{m.name}</h2>
        <p className="lib-muted">{mcpSourceLabel(m.source)}</p>
      </div>
      <span className="ext-badges">
        <Badge tone={m.consented ? "ok" : "neutral"}>{m.consented ? "Consented" : "No consent yet"}</Badge>
        <Badge tone={m.enabled ? "ok" : "neutral"}>{m.enabled ? "On" : "Off"}</Badge>
        {m.credentialMissing && <Badge tone="warn">Credential missing</Badge>}
        {m.enabled && m.effective === false && <Badge tone="warn">Not loaded in chats</Badge>}
      </span>
      <Facts rows={facts} />
      <p className="lib-muted">Consent before enabling — an enabled-but-unconsented server is never offered to the agent.</p>
      {m.enabled && <p className="lib-muted">Once enabled it is offered to the agent as mcp__{m.id}__* tools.</p>}
      {m.credentialMissing && <p className="lib-muted">No value is stored for this server&apos;s credential, so it will fail to authenticate.</p>}
      {m.versionLabel !== undefined && (
        <section aria-label="Version">
          <h3>Version</h3>
          <Facts rows={[[m.packageName ?? "Package", m.versionLabel]]} />
          {v === undefined && state.statusLoading && <p className="lib-muted">Checking the version…</p>}
          {v?.status === "unknown" && <p className="lib-muted">Could not look up the latest version{v.reason ? `: ${v.reason}` : "."}</p>}
          {v?.status === "update-available" && <p>A newer version is available{v.latest ? `: v${v.latest}` : "."}</p>}
          {v?.status === "unpinned" && <p className="lib-muted">Not pinned: it runs whatever version the registry serves.</p>}
          {v?.status === "up-to-date" && <p className="lib-muted">Up to date.</p>}
          {v === undefined && !state.statusLoading && state.statusError && <p className="lib-muted">Could not check the version: {state.statusError}</p>}
        </section>
      )}
    </div>
  );
}

function SourceDetail({ model, state, s, revealer }: { model: LegacyModel; state: LegacyState; s: LlmSourceRow; revealer?: LocationReveal }): ReactNode {
  const st = state.sourceUpdates[s.id];
  const busy = state.busy.includes(s.id);
  const d = state.discovery?.id === s.id ? state.discovery : null;
  // Mac primary button (LlmSourceDetailView.primaryUpdateButton): Install for a missing bundled kit, Rescan for a local
  // folder, else Update. Update is the only one that resets a git checkout, so it is shown only when an update exists
  // and always goes through the confirmation. All three call the same existing route, POST …/llm-sources/update.
  const install = s.builtin && !s.installed;
  const local = s.origin === "local";
  const updateAvailable = st?.status === "update-available";
  const reveal = revealer && s.location && s.installed && revealer.canReveal(s.location) ? s.location : null;
  return (
    <div className="ext-detail" aria-label={`Details of ${s.name}`}>
      <div className="ext-detail-head">
        <h2>{s.name}</h2>
        <p className="lib-muted">{s.version ? `v${s.version}` : "No version"}</p>
      </div>
      <span className="ext-badges">
        <Badge tone={s.enabled ? "ok" : "neutral"}>{s.enabled ? "On" : "Off"}</Badge>
        {s.origin && <Badge>{s.origin}</Badge>}
        {!s.installed && <Badge tone="warn">Not installed</Badge>}
        {st?.status === "update-available" && <Badge tone="accent">Update available</Badge>}
      </span>
      <Facts
        rows={[
          ["Origin", s.origin || "unknown"],
          ...(s.location ? ([["Location", s.location]] as [string, string][]) : []),
          ...(s.ref ? ([["Ref", s.ref]] as [string, string][]) : []),
          ["Skills", String(s.skillCount)],
          ["Agents", String(s.agentCount)],
          ["Commands", String(s.commandCount)],
          ["Templates", String(s.templateCount)],
          ["Hooks", String(s.hookCount)],
          ["MCP servers", String(s.mcpCount)],
        ]}
      />
      {s.builtin && !s.installed && <p className="lib-muted">The bundled .skills submodule isn&apos;t checked out. Install to fetch it.</p>}
      <section aria-label="Upstream status">
        {state.statusLoading && !st ? (
          <p className="lib-muted" role="status">
            Checking for updates…
          </p>
        ) : st?.status === "update-available" ? (
          <p>Update available.</p>
        ) : st?.status === "up-to-date" ? (
          <p className="lib-muted">Up to date.</p>
        ) : st?.status === "local" ? (
          <p className="lib-muted">Local folder — a rescan picks up changes made on disk.</p>
        ) : st?.status === "diverged" ? (
          <p>{st.message ?? "This source has local commits; update it with git."}</p>
        ) : st ? (
          <p className="lib-muted">Couldn&apos;t check for updates{st.message ? `: ${st.message}` : "."}</p>
        ) : state.statusError ? (
          <p className="lib-muted">Could not check for updates: {state.statusError}</p>
        ) : null}
        <div className="ext-actions">
          <button type="button" className="lib-btn" disabled={state.statusLoading || !s.installed || local} onClick={() => void model.checkSourceUpdates()}>
            Check for updates
          </button>
          {updateAvailable && (
            <button type="button" className="lib-btn lib-btn-primary" disabled={busy || (!s.builtin && !s.installed)} onClick={() => model.requestSourceUpdate(s.id)}>
              Update
            </button>
          )}
          {!updateAvailable && install && (
            <button type="button" className="lib-btn" disabled={busy} onClick={() => void model.updateSource(s.id)}>
              Install
            </button>
          )}
          {!updateAvailable && !install && local && (
            <button type="button" className="lib-btn" disabled={busy || !s.installed} onClick={() => void model.updateSource(s.id)}>
              Rescan
            </button>
          )}
          {reveal !== null && (
            <button type="button" className="lib-btn" disabled={busy} onClick={() => revealer?.reveal(reveal)}>
              Reveal
            </button>
          )}
        </div>
      </section>
      {d?.loading && (
        <p className="lib-muted" role="status">
          Loading contents…
        </p>
      )}
      {d?.error && (
        <p role="alert" className="ext-inline-error">
          {d.error}
        </p>
      )}
      {d?.data && (
        <>
          <ItemsBlock model={model} busy={busy} title="Skills" kind="skill" items={d.data.skills} />
          <ItemsBlock model={model} busy={busy} title="Agents" kind="agent" items={d.data.agents} caption="Agents from a source aren't run by LLM-IDE yet — your selection is saved for when they are." />
          <ItemsBlock model={model} busy={busy} title="Commands" kind="command" items={d.data.commands} />
          <ItemsBlock model={model} busy={busy} title="Templates" kind="template" items={d.data.templates} />
          {d.data.hooks.length > 0 && (
            <section aria-label="Hooks">
              <h3>Hooks ({d.data.hooks.length})</h3>
              <p className="lib-muted">Listed for visibility only — hooks from a registered source are never executed.</p>
              <ul className="ext-members">
                {d.data.hooks.map((h, i) => (
                  <li key={`${h.event}-${i}`}>
                    <strong>{h.event}</strong>
                    {h.matcher && <span className="lib-muted">{h.matcher}</span>}
                    <code>{h.command}</code>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {d.data.mcpServers.length > 0 && (
            <section aria-label="MCP servers">
              <h3>MCP servers ({d.data.mcpServers.length})</h3>
              <p className="lib-muted">Listed for visibility only — this app never connects to or spawns a source&apos;s MCP servers.</p>
              <ul className="ext-members">
                {d.data.mcpServers.map((m) => (
                  <li key={m.name}>
                    <strong>{m.name}</strong>
                    <code>{[m.command, ...m.args].join(" ")}</code>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function ItemsBlock({ model, busy, title, kind, items, caption }: { model: LegacyModel; busy: boolean; title: string; kind: string; items: readonly DiscoveryItem[]; caption?: string }): ReactNode {
  if (items.length === 0) return null;
  const on = items.filter((i) => i.enabled).length;
  return (
    <section aria-label={title}>
      <div className="ext-switch-row">
        <h3>
          {title} ({on} of {items.length} on)
        </h3>
        <button type="button" className="lib-btn" disabled={busy || on === items.length} onClick={() => void model.setItems(kind, items.filter((i) => !i.enabled).map((i) => i.name), true)}>
          All
        </button>
        <button type="button" className="lib-btn" disabled={busy || on === 0} onClick={() => void model.setItems(kind, items.filter((i) => i.enabled).map((i) => i.name), false)}>
          None
        </button>
      </div>
      {caption && <p className="lib-muted">{caption}</p>}
      <ul className="ext-members">
        {items.map((it) => {
          const id = `ext-src-${kind}-${it.name}`;
          return (
            <li key={it.name}>
              <input id={id} type="checkbox" checked={it.enabled} disabled={busy} onChange={(e) => void model.setItems(kind, [it.name], e.target.checked)} aria-label={`${kind} ${it.label}`} />
              <label htmlFor={id}>{kind === "command" ? `/${it.label}` : it.label}</label>
              {it.isNew && <Badge tone="accent">New</Badge>}
              {it.description && <span className="lib-muted">{it.description}</span>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
