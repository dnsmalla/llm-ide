import { Component, Suspense, lazy, useEffect, useRef, useState, useSyncExternalStore, type ComponentType, type ReactNode } from "react";
import "@llmide/ui-kit/styles.css";
import "./settings.css";
import { SettingsSectionCard } from "@llmide/ui-kit";
import type { SettingsRegistry, Loader } from "./registry.ts";
import { settingsRegistry, type SectionComponent } from "./registry-default.ts";
import { SettingsEnvProvider } from "./context.tsx";
import type { SettingsEnv } from "./host.ts";
import { APP_GROUPS, ExpandedGroups, NO_SEARCH_TOGGLES, REMOTE_GROUP_HIDDEN, keepMounted, resolveAnchor, toggleSearchMatch, type SearchToggles } from "./groups.ts";
import { SettingsGroup } from "./SettingsGroup.tsx";
import { selfHealEnabled, subscribeSelfHeal } from "../shell/self-heal.ts";

class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override render(): ReactNode {
    return this.state.failed ? <p className="st-error" role="alert">This section could not be shown. Close Settings and open it again.</p> : this.props.children;
  }
}

// One lazy component per loader, created once (React.lazy must not be recreated on render).
const lazyCache = new WeakMap<Loader<SectionComponent>, ComponentType>();
function lazyOf(load: Loader<SectionComponent>): ComponentType {
  let c = lazyCache.get(load);
  if (!c) {
    c = lazy(load) as unknown as ComponentType;
    lazyCache.set(load, c);
  }
  return c;
}

export interface SettingsScreenProps {
  env: SettingsEnv;
  /** Defaults to the shared registry; tests and other screens can pass their own. */
  registry?: SettingsRegistry<SectionComponent>;
  /** A group id (or `settings:<id>`, or an old anchor): that group opens and scrolls into view. */
  initialSection?: string;
  /** Where the expanded state is remembered; tests pass a fake, the default is the webview's localStorage. */
  expanded?: ExpandedGroups;
}

/** The group a deep link names, if this registry has it (a custom registry's own ids are honoured too). */
export function targetGroup(registry: SettingsRegistry<SectionComponent>, anchor: string | undefined): string | null {
  if (!anchor || anchor.length > 64) return null;
  const bare = anchor.startsWith("settings:") ? anchor.slice("settings:".length) : anchor;
  if (registry.section(bare)) return bare;
  const id = resolveAnchor(bare);
  return id !== null && registry.section(id) ? id : null;
}

/** The Mac's single "App" page: a centred column of collapsible group rows (default collapsed, state remembered). */
export function SettingsScreen({ env, registry = settingsRegistry, initialSection, expanded }: SettingsScreenProps) {
  useSyncExternalStore(registry.subscribe, registry.version, registry.version);
  const store = useRef<ExpandedGroups | null>(null);
  if (store.current === null) store.current = expanded ?? new ExpandedGroups();
  const target = targetGroup(registry, initialSection);
  // A deep link opens its group before the first paint (and remembers it, like a click would).
  const opened = useRef(false);
  if (target && !opened.current) {
    opened.current = true;
    store.current.set(target, true);
  }
  const [showHelp, setShowHelp] = useState(false);
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const matches = (title: string) => q.length === 0 || title.toLowerCase().includes(q);
  const [, bump] = useState(0);
  // While a search is on, every match is shown open; a click then collapses (or reopens) just that match.
  const [search, setSearch] = useState<SearchToggles>(NO_SEARCH_TOGGLES);
  // Groups the user has opened: their bodies stay mounted (hidden) after closing. Search-shown matches are not kept.
  const keptMounted = useRef(new Set<string>());
  // Each query is a fresh search: earlier clicks on matches do not carry over.
  const changeQuery = (value: string) => {
    setQuery(value);
    setSearch(NO_SEARCH_TOGGLES);
  };
  const toggle = (id: string) => {
    if (q.length > 0) {
      setSearch((t) => toggleSearchMatch(t, id));
      return;
    }
    const opening = !store.current!.isOpen(id);
    // One section at a time: opening a group closes the others, so the page never becomes a long stack.
    if (opening) for (const s of [...registry.sectionsIn("app"), ...registry.sectionsIn("project")]) if (s.id !== id) store.current!.set(s.id, false);
    store.current!.set(id, opening);
    bump((n) => n + 1);
  };
  useEffect(() => {
    if (!target) return;
    const el = document.getElementById(`st-group-${target}`);
    el?.scrollIntoView?.({ block: "start", behavior: "smooth" });
  }, [target]);

  // Team shows for every signed-in member: the project picker is per project (ADR 0022); the
  // team-wide member/invite panels inside it stay owner/admin-only and re-check the enforced role.

  const hasProject = Boolean(env.host.activeProjectPath?.());
  // Self-Heal shows only after the host said this debug build records (shell/self-heal.ts); never in a release build.
  const devOn = useSyncExternalStore(subscribeSelfHeal, selfHealEnabled, () => false);
  const hidden = new Set(env.serverMode === "remote" ? REMOTE_GROUP_HIDDEN : []);
  const dead = new Set(APP_GROUPS.filter((g) => g.status === "mac-only" || (g.status === "dev-only" && !devOn) || hidden.has(g.id)).map((g) => g.id));
  const app = registry.sectionsIn("app").filter((s) => !dead.has(s.id) && matches(s.title));
  const project = hasProject ? registry.sectionsIn("project").filter((s) => matches(s.title)) : [];
  const row = (s: ReturnType<SettingsRegistry<SectionComponent>["sections"]>[number]) => {
    const open = q.length > 0 ? !search.collapsed.has(s.id) : store.current!.isOpen(s.id);
    const userOpened = q.length > 0 ? search.reopened.has(s.id) : open;
    const mounted = keepMounted(keptMounted.current, s.id, open, userOpened);
    const Body = lazyOf(s.load);
    const cards = registry.cardsFor(s.id);
    return (
      <li key={s.id}>
        <SettingsGroup id={s.id} title={s.title} icon={s.icon} open={open} mounted={mounted} onToggle={() => toggle(s.id)}>
          <Boundary>
            <Suspense fallback={<p className="st-hint" role="status">Loading...</p>}>
              <div className="st-stack">
                <Body />
                {cards.map((c) => {
                  const Card = lazyOf(c.load);
                  return (
                    <SettingsSectionCard key={c.id} icon={null} title={c.title} defaultExpanded>
                      <Suspense fallback={<p className="st-hint" role="status">Loading...</p>}><Card /></Suspense>
                    </SettingsSectionCard>
                  );
                })}
              </div>
            </Suspense>
          </Boundary>
        </SettingsGroup>
      </li>
    );
  };

  return (
    <SettingsEnvProvider env={env}>
      <div className="st-root">
        <main className={"st-page" + (showHelp ? "" : " st-hide-help")} aria-labelledby="st-title">
          <div className="st-page-head">
            <h1 id="st-title" className="st-h1">Settings</h1>
            <button type="button" className="st-help-toggle" aria-pressed={showHelp} onClick={() => setShowHelp((v) => !v)}>{showHelp ? "Hide help" : "Show help"}</button>
          </div>
          <div className="st-search"><input type="search" value={query} onChange={(e) => changeQuery(e.target.value)} placeholder="Search settings…" aria-label="Search settings" autoComplete="off" spellCheck={false} /></div>
          {app.length > 0 ? <ul className="st-groups" aria-label="Settings groups">{app.map(row)}</ul> : <p className="st-empty" role="status">No settings match “{query.trim()}”.</p>}
          {project.length > 0 ? (
            <div role="group" aria-labelledby="st-band-project" className="st-band-wrap">
              <p id="st-band-project" className="st-h1">Project</p>
              <ul className="st-groups" aria-label="Project settings groups">{project.map(row)}</ul>
            </div>
          ) : null}
        </main>
      </div>
    </SettingsEnvProvider>
  );
}
