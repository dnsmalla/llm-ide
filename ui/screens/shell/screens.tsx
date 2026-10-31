// Lazy loading of section bundles. A screen is `ui/screens/<name>/index.tsx` with a default export
// taking `SectionProps`; until a slice lands its entry the section shows a placeholder. The glob is
// resolved at build time, so each present screen becomes its own chunk loaded on first open.
import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import type { SectionId, SectionProps } from "./sections";

type Loader = () => Promise<{ default?: ComponentType<SectionProps> }>;

const GLOB = import.meta.glob<{ default?: ComponentType<SectionProps> }>("../{chat,explorer,library,settings}/index.tsx");

function Missing({ name }: { name: string }) {
  return (
    <div className="sh-panel" role="status">
      <h2 className="sh-panel-title">{name} is not available yet</h2>
      <p className="sh-panel-text sh-muted">This screen has not landed in this build.</p>
    </div>
  );
}

const cache = new Map<string, LazyExoticComponent<ComponentType<SectionProps>>>();

/** The lazy component for a section, or null when there is no screen module for it. */
export function screenFor(id: SectionId, label: string): LazyExoticComponent<ComponentType<SectionProps>> | null {
  const loader: Loader | undefined = GLOB[`../${id}/index.tsx`];
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
