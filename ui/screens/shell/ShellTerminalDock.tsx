// The Terminal dock for every section except Explorer, which renders the same shared dock inside its editor
// column. One open state and one manager mean Ctrl+`, the status-bar item and both dock positions agree.
import { useEffect, useState, type ReactNode } from "react";
import { TerminalDock, clampDock, DOCK_DEFAULT } from "../explorer/terminal/TerminalDock";
import { TerminalIcon } from "@llmide/ui-kit";
import { TERMINAL_BUILT, loadTerminalRuntime, sharedTerminalManager } from "../explorer/terminal/shared";
import type { TerminalRuntime } from "../explorer/terminal/runtime-types";
import { readTerminalPrefs, writeTerminalPrefs } from "./terminal-prefs";
import { terminalCwd } from "../settings/repo-config.ts";
import type { SectionId } from "./sections";

export function ShellTerminalDock({ activeSection, projectRoot, projectName, open, onToggle }: { activeSection: SectionId; projectRoot: string | null; projectName: string; open: boolean; onToggle: (open: boolean) => void }): ReactNode {
  const initial = readTerminalPrefs();
  const [height, setHeight] = useState(clampDock(initial.height, typeof window === "undefined" ? 1000 : window.innerHeight));
  const [runtime, setRuntime] = useState<TerminalRuntime | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [ever, setEver] = useState(open);
  const terminal = sharedTerminalManager();

  useEffect(() => { if (open) setEver(true); }, [open]);
  const show = (next: boolean) => { if (!TERMINAL_BUILT) return; onToggle(next); };

  useEffect(() => {
    if (!open || runtime) return;
    let live = true;
    void loadTerminalRuntime().then((r) => { if (live) { setRuntime(r); setLoadError(null); } }, (e: unknown) => { if (live) setLoadError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [open, runtime, attempt]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key !== "`") return;
      e.preventDefault();
      show(!open);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, show]);

  if (!TERMINAL_BUILT || activeSection === "explorer") return null;
  if (!ever) return null;
  if (!runtime) {
    if (!open) return null;
    if (loadError) return <div className="sh-panel-text" role="alert">The terminal could not load: {loadError} <button type="button" className="sh-button" onClick={() => { setLoadError(null); setAttempt((n) => n + 1); }}>Retry</button></div>;
    return <p className="sh-panel-text sh-muted" role="status">Loading terminal…</p>;
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
export function ShellTerminalItem({ onToggle, built, open }: { onToggle: () => void; built: boolean; open: boolean }): ReactNode {
  if (!built) return null;
  return (
    <button type="button" className="sh-statusbar-item sh-statusbar-terminal" data-open={open || undefined} aria-pressed={open} aria-expanded={open} onClick={onToggle} title={open ? "Hide terminal (Ctrl+`)" : "Show terminal (Ctrl+`)"}>
      <TerminalIcon />
      <span>Terminal</span>
    </button>
  );
}
