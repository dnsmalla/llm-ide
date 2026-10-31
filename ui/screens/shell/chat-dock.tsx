// The seam through which a screen embeds the Code Assistant without importing the Chat screen (Mac
// `ChatPanelRegistry` / `ChatPanelView`): the shell installs a loader once at boot (`screens.tsx`), screens render
// `<ChatDockSlot>`. When nothing is installed (a node test, a build without Chat) the slot shows a visible
// "unavailable" note, never an empty column, so a wiring bug is seen instead of hidden.
import { Suspense, lazy, type ComponentType, type LazyExoticComponent } from "react";
import { SectionErrorBoundary } from "./ErrorBoundary";

export interface ChatDockProps {
  /** The dock is on screen (its section is current and it is open): only then does it poll or re-attach. */
  active: boolean;
  projectRoot: string | null;
  /** Hides the dock; the dock's header shows a button when given. */
  onCollapse?: () => void;
}

type Loader = () => Promise<{ default: ComponentType<ChatDockProps> }>;

let installed: LazyExoticComponent<ComponentType<ChatDockProps>> | null = null;

/** Install the dock maker (last install wins, like the Mac registry). */
export function installChatDock(load: Loader): void {
  installed = lazy(load);
}

export function isChatDockInstalled(): boolean {
  return installed !== null;
}

/** Test hook: forget the installed maker. */
export function resetChatDock(): void {
  installed = null;
}

export function ChatDockSlot(props: ChatDockProps) {
  const Dock = installed;
  if (!Dock) return <p className="sh-panel-text sh-muted sh-dock-note" role="status">The Code Assistant is not available in this build.</p>;
  return (
    <SectionErrorBoundary name="Code Assistant">
      <Suspense fallback={<p className="sh-panel-text sh-muted sh-dock-note" role="status" aria-busy="true">Loading Code Assistant…</p>}>
        <Dock {...props} />
      </Suspense>
    </SectionErrorBoundary>
  );
}
