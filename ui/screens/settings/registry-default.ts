// The built-in Settings groups: the Mac's order and titles (groups.ts), each body loaded lazily (its own chunk, fetched
// only when the group is first opened). Other screens add a card to a group with `registerCard(<group id>, ...)`.
import type { ComponentType } from "react";
import { ALL_GROUPS } from "./groups.ts";
import { SettingsRegistry, type Loader } from "./registry.ts";

export type SectionComponent = ComponentType<Record<string, never>>;

const named = (file: () => Promise<Record<string, unknown>>, pick: string): Loader<SectionComponent> => () =>
  file().then((m) => ({ default: m[pick] as SectionComponent }));
const dflt = (file: () => Promise<{ default: unknown }>): Loader<SectionComponent> => () =>
  file().then((m) => ({ default: m.default as SectionComponent }));

const notices = () => import("./sections/NoticeSections.tsx");
const trust = () => import("./sections/ExtensionsTrustSection.tsx");

const BODIES: Readonly<Record<string, Loader<SectionComponent>>> = {
  workspace: dflt(() => import("./sections/WorkspaceGroup.tsx")),
  build: named(notices, "BuildGroup"),
  server: dflt(() => import("./sections/ServerSection.tsx")),
  connections: named(notices, "ConnectionsGroup"),
  updates: dflt(() => import("./sections/UpdatesSection.tsx")),
  mobile: named(notices, "MobileGroup"),
  general: dflt(() => import("./sections/GeneralSection.tsx")),
  "tool-permissions": dflt(() => import("./sections/ToolPermissionsSection.tsx")),
  "agent-sdk": dflt(() => import("./sections/AgentSdkSection.tsx")),
  "token-saving": named(notices, "TokenSavingGroup"),
  providers: dflt(() => import("./sections/ProvidersSection.tsx")),
  "model-routing": dflt(() => import("./sections/RoutingSection.tsx")),
  "loop-defaults": named(notices, "LoopDefaultsGroup"),
  "doc-gen": named(notices, "DocGenGroup"),
  "agent-history": dflt(() => import("./sections/AgentHistorySection.tsx")),
  "folder-trust": named(trust, "TrustedFolders"),
  "extension-sources": named(trust, "Allowlist"),
  "optional-components": named(notices, "OptionalComponentsGroup"),
  "self-heal": named(notices, "SelfHealGroup"),
  paths: named(notices, "PathsGroup"),
  repositories: named(notices, "RepositoriesGroup"),
  memory: named(notices, "MemoryGroup"),
  "code-graph": named(notices, "CodeGraphGroup"),
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
