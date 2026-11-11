// The built-in Settings groups: the Mac's order and titles (groups.ts), each body loaded lazily (its own chunk, fetched
// only when the group is first opened). Other screens add a card to a group with `registerCard(<group id>, ...)`.
import type { ComponentType } from "react";
import { ALL_GROUPS } from "./groups.ts";
import { SettingsRegistry, type Loader } from "./registry.ts";

export type SectionComponent = ComponentType<Record<string, never>>;

const dflt = (file: () => Promise<{ default: unknown }>): Loader<SectionComponent> => () =>
  file().then((m) => ({ default: m.default as SectionComponent }));

const BODIES: Readonly<Record<string, Loader<SectionComponent>>> = {
  workspace: dflt(() => import("./sections/WorkspaceGroup.tsx")),
  server: dflt(() => import("./sections/ServerGroup.tsx")),
  updates: dflt(() => import("./sections/UpdatesSection.tsx")),
  mobile: dflt(() => import("./sections/MobileBridge.tsx")),
  team: dflt(() => import("./sections/TeamSection.tsx")),
  general: dflt(() => import("./sections/GeneralSection.tsx")),
  providers: dflt(() => import("./sections/ProvidersSection.tsx")),
  "model-routing": dflt(() => import("./sections/ModelsGroup.tsx")),
  "agent-history": dflt(() => import("./sections/AgentHistorySection.tsx")),
  trust: dflt(() => import("./sections/TrustGroup.tsx")),
  "optional-components": dflt(() => import("./sections/OptionalComponentsSection.tsx")),
  "self-heal": dflt(() => import("./sections/SelfHealSection.tsx")),
  paths: dflt(() => import("./sections/PathsSection.tsx")),
  repositories: dflt(() => import("./sections/RepositoriesSection.tsx")),
  memory: dflt(() => import("./sections/MemoryGroup.tsx")),
};

export function createSettingsRegistry(): SettingsRegistry<SectionComponent> {
  const r = new SettingsRegistry<SectionComponent>();
  ALL_GROUPS.forEach((g, i) => {
    const load = BODIES[g.id];
    if (!load) throw new Error(`settings group "${g.id}" has no body`);
    r.registerSection({ id: g.id, title: g.title, order: (i + 1) * 10, load, icon: g.icon, band: g.band });
  });
  return r;
}

/** The registry the app uses. Other screens call `settingsRegistry.registerCard(groupId, ...)` at startup. */
export const settingsRegistry: SettingsRegistry<SectionComponent> = createSettingsRegistry();
