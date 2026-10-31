import { Component, Suspense, lazy, useEffect, useRef, useState, useSyncExternalStore, type ComponentType, type ReactNode } from "react";
import "@llmide/ui-kit/styles.css";
import "./settings.css";
import { SettingsSectionCard } from "@llmide/ui-kit";
import type { SettingsRegistry, Loader } from "./registry.ts";
import { settingsRegistry, type SectionComponent } from "./registry-default.ts";
import { SettingsEnvProvider } from "./context.tsx";
import type { SettingsEnv } from "./host.ts";
import { ExpandedGroups, resolveAnchor } from "./groups.ts";
import { SettingsGroup } from "./SettingsGroup.tsx";

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
  const [, bump] = useState(0);
  const toggle = (id: string) => {
    store.current!.toggle(id);
    bump((n) => n + 1);
  };
  useEffect(() => {
    if (!target) return;
    const el = document.getElementById(`st-group-${target}`);
    el?.scrollIntoView?.({ block: "start", behavior: "smooth" });
  }, [target]);

  const hasProject = Boolean(env.host.activeProjectPath?.());
  const app = registry.sectionsIn("app");
  const project = hasProject ? registry.sectionsIn("project") : [];
  const row = (s: ReturnType<SettingsRegistry<SectionComponent>["sections"]>[number]) => {
    const open = store.current!.isOpen(s.id);
    const Body = lazyOf(s.load);
    const cards = registry.cardsFor(s.id);
    return (
      <li key={s.id}>
        <SettingsGroup id={s.id} title={s.title} icon={s.icon} open={open} onToggle={() => toggle(s.id)}>
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
        <main className="st-page" aria-labelledby="st-title">
          <h1 id="st-title" className="st-h1">App</h1>
          <ul className="st-groups" aria-label="Settings groups">{app.map(row)}</ul>
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
