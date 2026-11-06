// Lazy loading of section bundles. A screen is `ui/screens/<name>/index.tsx` with a default export taking
// `SectionProps`. Each screen is its own chunk, loaded on first open.
//
// Feature pruning: the loader map is built with compile-time `__FEATURE_*__` booleans (vite.config.ts defines them
// from LLMIDE_BUILD_FEATURES). A disabled screen's branch is dead code, so Rollup drops the dynamic import and the
// chunk is not in the bundle at all — the "Apply & Rebuild" promise is real here, not just a hidden button.
import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import type { SectionId, SectionProps } from "./sections";
import { installChatDock, type ChatDockProps } from "./chat-dock";

declare const __FEATURE_FILE_EXPLORER__: boolean | undefined;
declare const __FEATURE_CODE_GRAPH_3D__: boolean | undefined;
declare const __FEATURE_DOC_GEN__: boolean | undefined;
declare const __FEATURE_GANTT_ISSUES__: boolean | undefined;
declare const __FEATURE_AUTO_TASKS__: boolean | undefined;

type Loader = () => Promise<{ default?: ComponentType<SectionProps> }>;

// Direct compile-time guards: with a define of `false` Rollup folds the condition and drops the dynamic import
// (a helper function call would not be constant-folded, keeping every chunk). In tests the define is absent, and
// `typeof` on an undeclared identifier is safe.
function Missing({ name }: { name: string }) {
  return (
    <div className="sh-panel" role="status">
      <h2 className="sh-panel-title">{name} is not available yet</h2>
      <p className="sh-panel-text sh-muted">This screen has not landed in this build.</p>
    </div>
  );
}

// Always-compiled screens (Chat is the product's one non-excludable feature; Library/Settings/Home have no key).
const loaders: Partial<Record<SectionId, Loader>> = {
  welcome: () => import("../welcome/index.tsx"),
  chat: () => import("../chat/index.tsx"),
  library: () => import("../library/index.tsx"),
  live: () => import("../live/index.tsx"),
  settings: () => import("../settings/index.tsx"),
  conflicts: () => import("../review/index.tsx"),
};
if (typeof __FEATURE_FILE_EXPLORER__ === "undefined" || __FEATURE_FILE_EXPLORER__) loaders.explorer = () => import("../explorer/index.tsx");
if (typeof __FEATURE_CODE_GRAPH_3D__ === "undefined" || __FEATURE_CODE_GRAPH_3D__) loaders.graph = () => import("../graph/index.tsx");
if (typeof __FEATURE_GANTT_ISSUES__ === "undefined" || __FEATURE_GANTT_ISSUES__) {
  loaders.issues = () => import("../issues/index.tsx");
  loaders.gantt = () => import("../gantt/index.tsx");
}
if (typeof __FEATURE_DOC_GEN__ === "undefined" || __FEATURE_DOC_GEN__) {
  loaders.docgen = () => import("../docgen/index.tsx");
  loaders.visual = () => import("../docgen/visual.tsx");
}
if (typeof __FEATURE_AUTO_TASKS__ === "undefined" || __FEATURE_AUTO_TASKS__) {
  loaders.autotasks = () => import("../autotasks/index.tsx");
  loaders.loop = () => import("../loop/index.tsx");
}

const cache = new Map<string, LazyExoticComponent<ComponentType<SectionProps>>>();

/** The lazy component for a section, or null when this build has no screen module for it. */
export function screenFor(id: SectionId, label: string): LazyExoticComponent<ComponentType<SectionProps>> | null {
  const loader = loaders[id];
  if (!loader) return null;
  let c = cache.get(id);
  if (!c) {
    c = lazy(async () => {
      const m = await loader();
      return { default: m.default ?? (() => <Missing name={label} />) };
    });
    cache.set(id, c);
  }
  return c;
}

export { Missing as MissingScreen };

// The Explorer's docked Code Assistant: the shell installs Chat's dock maker (Mac `FeatureCatalog.installChatSeams`),
// so Explorer renders `ChatDockSlot` and never names the Chat screen. One chunk, loaded when the dock first opens.
const dockLoader = (() => import("../chat/dock.tsx")) as () => Promise<{ default: ComponentType<ChatDockProps> }>;
installChatDock(dockLoader);
