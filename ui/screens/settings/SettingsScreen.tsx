import { Component, Suspense, lazy, useState, useSyncExternalStore, type ComponentType, type ReactNode } from "react";
import "@llmide/ui-kit/styles.css";
import "./settings.css";
import { SettingsSectionCard } from "@llmide/ui-kit";
import type { SettingsRegistry, Loader } from "./registry.ts";
import { settingsRegistry, type SectionComponent } from "./registry-default.ts";
import { SettingsEnvProvider } from "./context.tsx";
import type { SettingsEnv } from "./host.ts";

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
  initialSection?: string;
}

export function SettingsScreen({ env, registry = settingsRegistry, initialSection }: SettingsScreenProps) {
  useSyncExternalStore(registry.subscribe, registry.version, registry.version);
  const sections = registry.sections();
  const [active, setActive] = useState(initialSection ?? sections[0]?.id ?? "");
  const section = registry.section(active) ?? sections[0];
  const Body = section ? lazyOf(section.load) : null;
  const cards = section ? registry.cardsFor(section.id) : [];

  return (
    <SettingsEnvProvider env={env}>
      <div className="st-root">
        <nav className="st-nav" aria-label="Settings sections">
          <ul>
            {sections.map((s) => (
              <li key={s.id}>
                <button type="button" className="st-nav-item" aria-current={s.id === section?.id ? "page" : undefined} onClick={() => setActive(s.id)}>
                  {s.title}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <main className="st-main" aria-labelledby="st-title">
          <h1 id="st-title" className="st-h1">{section?.title ?? "Settings"}</h1>
          <Boundary key={section?.id}>
            <Suspense fallback={<p className="st-hint" role="status">Loading...</p>}>{Body ? <Body /> : null}</Suspense>
            {cards.map((c) => {
              const Card = lazyOf(c.load);
              return (
                <SettingsSectionCard key={c.id} icon={null} title={c.title} defaultExpanded>
                  <Suspense fallback={<p className="st-hint" role="status">Loading...</p>}><Card /></Suspense>
                </SettingsSectionCard>
              );
            })}
          </Boundary>
        </main>
      </div>
    </SettingsEnvProvider>
  );
}
