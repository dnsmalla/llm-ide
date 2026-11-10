// The Terminal dock for every section except Explorer (Explorer embeds its own copy above its status strip, like
// the Mac). Ctrl+` and the status-bar item toggle it; one shared manager means tabs survive section switches.
import { useEffect, useState, type ReactNode } from "react";
import { TerminalDock, clampDock, DOCK_DEFAULT } from "../explorer/terminal/TerminalDock";
import { TerminalIcon } from "@llmide/ui-kit";
import { TERMINAL_BUILT, loadTerminalRuntime, sharedTerminalManager } from "../explorer/terminal/shared";
import type { TerminalRuntime } from "../explorer/terminal/runtime-types";
import { readTerminalPrefs, writeTerminalPrefs } from "./terminal-prefs";
import type { SectionId } from "./sections";
import { terminalCwd } from "../settings/repo-config.ts";

export function ShellTerminalDock({ activeSection, projectRoot, projectName, open, onToggle }: { activeSection: SectionId; projectRoot: string | null; projectName: string; open: boolean; onToggle: (open: boolean) => void }): ReactNode {
  const initial = readTerminalPrefs();
  const [height, setHeight] = useState(clampDock(initial.height, typeof window === "undefined" ? 1000 : window.innerHeight));
  const [runtime, setRuntime] = useState<TerminalRuntime | null>(null);
  const [ever, setEver] = useState(open);
  const terminal = sharedTerminalManager();

  useEffect(() => { if (open) setEver(true); }, [open]);
  const show = (next: boolean) => { if (!TERMINAL_BUILT) return; onToggle(next); };

  useEffect(() => {
    if (!open || runtime) return;
    let live = true;
    void loadTerminalRuntime().then((r) => { if (live) setRuntime(r); }, () => undefined);
    return () => { live = false; };
  }, [open, runtime]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key !== "`") return;
      if (activeSection === "explorer") return;
      e.preventDefault();
      show(!open);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeSection, open, show]);

  if (!TERMINAL_BUILT || activeSection === "explorer") return null;
  if (!ever) return null;
  if (!runtime) {
    return open ? <p className="sh-panel-text sh-muted" role="status">Loading terminal…</p> : null;
  }
  return (
    <TerminalDock
      manager={terminal}
      runtime={runtime}
      projectRoot={terminalCwd(projectRoot)}
      projectName={projectName}
      open={open}
      height={height === DOCK_DEFAULT ? clampDock(DOCK_DEFAULT) : height}
      onHeightChange={(h) => { const c = clampDock(h, window.innerHeight); setHeight(c); writeTerminalPrefs({ open, height: c }); }}
      onClose={() => show(false)}
    />
  );
}

/** Status-bar toggle for the shell dock (Explorer owns its own toggle). */
export function ShellTerminalItem({ activeSection, onToggle, built, open }: { activeSection: SectionId; onToggle: () => void; built: boolean; open: boolean }): ReactNode {
  if (!built || activeSection === "explorer") return null;
  return (
    <button type="button" className="sh-statusbar-item sh-statusbar-terminal" data-open={open || undefined} aria-pressed={open} aria-expanded={open} onClick={onToggle} title={open ? "Hide terminal (Ctrl+`)" : "Show terminal (Ctrl+`)"}>
      <TerminalIcon />
      <span>Terminal</span>
    </button>
  );
}
