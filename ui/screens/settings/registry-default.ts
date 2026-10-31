// The built-in Settings sections, loaded lazily (each import() is its own chunk).
import type { ComponentType } from "react";
import { SettingsRegistry } from "./registry.ts";

export type SectionComponent = ComponentType<Record<string, never>>;

export function createSettingsRegistry(): SettingsRegistry<SectionComponent> {
  const r = new SettingsRegistry<SectionComponent>();
  const simple = (pick: "AppearanceSection" | "WorkspaceSection" | "FeaturesSection") => () =>
    import("./sections/SimpleSections.tsx").then((m) => ({ default: m[pick] as SectionComponent }));
  r.registerSection({ id: "providers", title: "Providers", order: 10, load: () => import("./sections/ProvidersSection.tsx") as Promise<{ default: SectionComponent }> });
  r.registerSection({ id: "routing", title: "Model routing", order: 20, load: () => import("./sections/RoutingSection.tsx") as Promise<{ default: SectionComponent }> });
  r.registerSection({ id: "agent-history", title: "Agent history", order: 30, load: () => import("./sections/AgentHistorySection.tsx") as Promise<{ default: SectionComponent }> });
  r.registerSection({ id: "extensions-trust", title: "Extensions trust", order: 40, load: () => import("./sections/ExtensionsTrustSection.tsx") as Promise<{ default: SectionComponent }> });
  r.registerSection({ id: "appearance", title: "Appearance", order: 50, load: simple("AppearanceSection") });
  r.registerSection({ id: "workspace", title: "Workspace", order: 60, load: simple("WorkspaceSection") });
  r.registerSection({ id: "features", title: "Features", order: 70, load: simple("FeaturesSection") });
  r.registerSection({ id: "account", title: "Account", order: 80, load: () => import("./sections/AccountSection.tsx") as Promise<{ default: SectionComponent }> });
  r.registerSection({ id: "about", title: "About", order: 90, load: () => import("./sections/AboutSection.tsx") as Promise<{ default: SectionComponent }> });
  return r;
}

/** The registry the app uses. Other screens call `settingsRegistry.registerCard(sectionId, ...)` at startup. */
export const settingsRegistry: SettingsRegistry<SectionComponent> = createSettingsRegistry();
