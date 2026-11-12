// The signed-in app shell: a left sidebar from 900px, an iOS-style tab bar below it, a header with the desktop, its connection
// status and the project picker, and one pane per section (see registry.ts). The section is the URL hash.
import { useEffect, useState } from "react";
import type { ConnectionState } from "../host-api/connection.ts";
import { ProjectPicker } from "../screens/ProjectPicker.tsx";
import { StatusPill, ToastHost, UiIcon, type ConnStatus } from "../ui/index.ts";
import { navigate, useRoute } from "./hash.ts";
import { visibleSections, type SectionDef, type ShellContext } from "./registry.ts";
import "./sections.tsx"; // registers the built-in sections

export function connStatus(conn: ConnectionState, waiting: boolean): ConnStatus {
  if (conn.kind === "ready") return "live";
  if (conn.kind === "reconnecting" || conn.kind === "connecting") return waiting ? "waiting" : "reconnecting";
  return "idle";
}

function NavItems({ sections, activeId, variant }: { sections: readonly SectionDef[]; activeId: string; variant: "side" | "tab" }) {
  return (
    <ul className={`shell-nav-list shell-nav-${variant}`}>
      {sections.map((s) => (
        <li key={s.id}>
          <a className="shell-nav-item" href={`#/${s.id}`} aria-current={s.id === activeId ? "page" : undefined}>
            <UiIcon name={s.icon} size={variant === "tab" ? 22 : 20} />
            <span>{variant === "tab" ? (s.shortLabel ?? s.label) : s.label}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

/** `forceSection` pins the section regardless of the URL (the dev gallery). */
export function Shell({ ctx, forceSection }: { ctx: ShellContext; forceSection?: string }) {
  const route = { ...useRoute() };
  if (forceSection) route.section = forceSection;
  const sections = visibleSections({ capabilities: ctx.capabilities, hub: ctx.hub });
  const active = sections.find((s) => s.id === route.section) ?? sections[0]!;
  const [visited, setVisited] = useState<ReadonlySet<string>>(() => new Set([active.id]));
  useEffect(() => { setVisited((v) => (v.has(active.id) ? v : new Set(v).add(active.id))); }, [active.id]);
  // A hash naming a hidden or unknown section falls back to the first visible one without leaving a dead entry in history.
  useEffect(() => { if (route.section && route.section !== active.id && !route.section.startsWith("__")) navigate(active.id, null, true); }, [route.section, active.id]);
  useEffect(() => { document.title = `${active.label} · LLM-IDE`; }, [active.label]);
  const status = connStatus(ctx.conn, ctx.chat.waiting);
  return (
    <div className="shell">
      <a className="shell-skip" href="#shell-main" onClick={(e) => { e.preventDefault(); document.getElementById("shell-main")?.focus(); }}>Skip to content</a>
      <aside className="shell-side">
        <a className="web-brand" href={`#/${sections[0]!.id}`} aria-label="LLM-IDE"><span className="web-mark" aria-hidden="true" /><span>LLM-IDE</span><em>web</em></a>
        <nav aria-label="Sections"><NavItems sections={sections} activeId={active.id} variant="side" /></nav>
        <p className="shell-side-foot">v{__APP_VERSION__}</p>
      </aside>
      <header className="shell-header">
        <div className="shell-heading">
          <span className="web-mark" aria-hidden="true" />
          <div><p className="shell-host">{ctx.hostName}</p><h1>{active.label}</h1></div>
        </div>
        <div className="shell-tools">
          <ProjectPicker state={ctx.projects} disabled={ctx.chat.turn !== null || (ctx.execute?.chat.turn ?? null) !== null} onSelect={ctx.actions.selectProject} />
          <div role="status" aria-live="polite" className="shell-status"><StatusPill status={status} /></div>
        </div>
      </header>
      <main id="shell-main" className="shell-main" tabIndex={-1}>
        {sections.map((s) => (s.id === active.id || (s.keepAlive && visited.has(s.id)) ? (
          <div key={s.id} className="shell-pane" data-layout={s.layout ?? "scroll"} data-section={s.id} hidden={s.id !== active.id}>
            <s.component ctx={ctx} />
          </div>
        ) : null))}
      </main>
      <nav className="shell-tabs" aria-label="Sections"><NavItems sections={sections} activeId={active.id} variant="tab" /></nav>
      <ToastHost />
    </div>
  );
}
