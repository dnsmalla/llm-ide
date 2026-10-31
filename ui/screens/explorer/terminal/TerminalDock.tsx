// Terminal dock at the bottom of the Explorer: tabs of real shells (xterm.js), consent and denied states,
// resizable, stays mounted when hidden so sessions survive section switches. Nothing spawns until the user
// asks (the native consent dialog appears on the first spawn).
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ConfirmDialog } from "../Dialogs";
import type { DockState, TerminalManager } from "./manager";
import { MAX_TABS } from "./manager";
import type { TermView, TerminalRuntime } from "./runtime-types";
import { AckBatcher, DEFAULT_SCROLLBACK, findUrls, isOpenableLink, needsPasteConfirm, sanitizePaste } from "./text";

export const DOCK_MIN = 120;
export const DOCK_MAX = 720;
export const DOCK_DEFAULT = 260;

export function clampDock(h: number, viewport = 1000): number {
  if (!Number.isFinite(h)) return DOCK_DEFAULT;
  return Math.round(Math.min(Math.max(h, DOCK_MIN), Math.max(DOCK_MIN, Math.min(DOCK_MAX, viewport - 200))));
}

export interface DockProps {
  manager: TerminalManager;
  runtime: TerminalRuntime;
  projectRoot: string | null;
  projectName: string;
  open: boolean;
  height: number;
  onHeightChange: (h: number) => void;
  onClose: () => void;
  scrollback?: number;
}

interface PasteAsk {
  text: string;
  resolve: (ok: boolean) => void;
}

const isMac = () => typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || navigator.userAgent || "");

export function TerminalDock({ manager, runtime, projectRoot, projectName, open, height, onHeightChange, onClose, scrollback = DEFAULT_SCROLLBACK }: DockProps) {
  const snap = useSyncExternalStore(manager.subscribe, manager.getSnapshot, manager.getSnapshot);
  const [paste, setPaste] = useState<PasteAsk | null>(null);
  const resize = useRef<{ y: number; h: number } | null>(null);

  // Read feature / consent state when the dock is first opened (no prompt, no spawn).
  useEffect(() => {
    if (open && snap.phase === "loading") void manager.refresh();
  }, [open, snap.phase, manager]);

  const newTab = useCallback(() => {
    manager.openTab();
  }, [manager]);

  const confirmPaste = useCallback((text: string) => new Promise<boolean>((resolve) => setPaste({ text, resolve })), []);

  const startFirst = () => {
    if (snap.tabs.length === 0) newTab();
  };

  const body = renderBody(snap, projectRoot, projectName, startFirst, () => void manager.retry());
  const showPanes = snap.tabs.length > 0;

  return (
    <section className="tm-dock" aria-label="Terminal" hidden={!open} style={{ height }}>
      <div
        className="tm-resizer"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize terminal"
        aria-valuemin={DOCK_MIN}
        aria-valuemax={DOCK_MAX}
        aria-valuenow={height}
        tabIndex={0}
        onPointerDown={(e) => {
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          resize.current = { y: e.clientY, h: height };
        }}
        onPointerMove={(e) => {
          const r = resize.current;
          if (r) onHeightChange(clampDock(r.h + (r.y - e.clientY), typeof window === "undefined" ? 1000 : window.innerHeight));
        }}
        onPointerUp={() => (resize.current = null)}
        onPointerCancel={() => (resize.current = null)}
        onKeyDown={(e) => {
          const step = e.key === "ArrowUp" ? 24 : e.key === "ArrowDown" ? -24 : e.key === "Home" ? DOCK_MAX : e.key === "End" ? -DOCK_MAX : 0;
          if (step === 0) return;
          e.preventDefault();
          onHeightChange(clampDock(height + step, typeof window === "undefined" ? 1000 : window.innerHeight));
        }}
      />
      <div className="tm-head">
        <div className="tm-tabs" role="tablist" aria-label="Terminals">
          {snap.tabs.map((t) => (
            <div key={t.id} className="tm-tab" data-active={snap.active === t.id} data-state={t.state}>
              <button type="button" role="tab" id={`tm-tab-${t.id}`} aria-selected={snap.active === t.id} aria-controls={`tm-pane-${t.id}`} tabIndex={snap.active === t.id ? 0 : -1} className="tm-tab-label" onClick={() => manager.activate(t.id)}>
                {t.title}
                {t.state === "exited" ? " (exited)" : ""}
              </button>
              <button type="button" className="tm-tab-close" aria-label={`Close ${t.title}`} title="Close terminal (kills the shell)" onClick={() => void manager.closeTab(t.id)}>×</button>
            </div>
          ))}
        </div>
        <button type="button" className="ui-icon-button" aria-label="New terminal" title={snap.tabs.length >= MAX_TABS ? `At most ${MAX_TABS} terminals` : "New terminal"} disabled={!projectRoot || snap.tabs.length >= MAX_TABS || snap.phase === "disabled" || snap.phase === "denied"} onClick={newTab}>+</button>
        <span className="ex-spacer" />
        <button type="button" className="ui-icon-button" aria-label="Hide terminal panel" title="Hide terminal (Ctrl+`). Shells keep running." onClick={onClose}>▾</button>
      </div>
      {snap.error && snap.tabs.length > 0 && <p className="tm-note" role="alert">{snap.error}</p>}
      <div className="tm-body">
        {!showPanes && body}
        {snap.tabs.map((t) => (
          <TerminalPane
            key={t.id}
            id={t.id}
            manager={manager}
            runtime={runtime}
            visible={open && snap.active === t.id}
            exited={t.state === "exited"}
            scrollback={scrollback}
            confirmPaste={confirmPaste}
            onRestart={() => {
              void manager.closeTab(t.id).then(() => manager.openTab());
            }}
          />
        ))}
      </div>
      {paste && (
        <ConfirmDialog
          title="Paste several lines?"
          message="This shell is not in bracketed-paste mode, so each line will run as soon as it is pasted."
          items={paste.text.split("\n").slice(0, 6).map((l) => (l.length > 80 ? `${l.slice(0, 80)}…` : l))}
          confirmLabel="Paste"
          danger
          onCancel={() => {
            paste.resolve(false);
            setPaste(null);
          }}
          onConfirm={() => {
            paste.resolve(true);
            setPaste(null);
          }}
        />
      )}
    </section>
  );
}

function renderBody(snap: DockState, projectRoot: string | null, projectName: string, start: () => void, retry: () => void) {
  if (!projectRoot) return <p className="tm-empty" role="status">Open a project to use the terminal. Shells start in the project folder.</p>;
  switch (snap.phase) {
    case "loading":
      return <p className="tm-empty" role="status">Checking terminal…</p>;
    case "disabled":
      return <p className="tm-empty" role="status">The Terminal feature is turned off in this build (<code>LLMIDE_FEATURES</code>), so no shell can be started.</p>;
    case "error":
      return <p className="tm-empty" role="alert">Terminal unavailable: {snap.error}</p>;
    case "denied":
      return (
        <div className="tm-consent" role="status">
          <p className="tm-consent-title">Terminal access was not approved</p>
          <p>No shell was started. You can ask again; your system will show the confirmation once more.</p>
          {snap.retryMessage && <p className="tm-note" role="alert">{snap.retryMessage}</p>}
          <button type="button" className="ex-btn ex-btn-primary" onClick={retry}>Try again</button>
        </div>
      );
    default:
      return (
        <div className="tm-consent">
          <p className="tm-consent-title">Open a terminal in {projectName}</p>
          <p>
            A terminal is a real {snap.status?.shell ?? "shell"} that runs with all of your user permissions (on Windows this is PowerShell or cmd). It starts in the project folder.
            LLM-IDE does not pass its own keys or tokens to it. Your system will ask you to confirm the first time.
          </p>
          {snap.error && <p className="tm-note" role="alert">{snap.error}</p>}
          <button type="button" className="ex-btn ex-btn-primary" onClick={start}>Start terminal</button>
        </div>
      );
  }
}

interface PaneProps {
  id: number;
  manager: TerminalManager;
  runtime: TerminalRuntime;
  visible: boolean;
  exited: boolean;
  scrollback: number;
  confirmPaste: (text: string) => Promise<boolean>;
  onRestart: () => void;
}

function TerminalPane({ id, manager, runtime, visible, exited, scrollback, confirmPaste, onRestart }: PaneProps) {
  const el = useRef<HTMLDivElement>(null);
  const view = useRef<TermView | null>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  useEffect(() => {
    const host = el.current;
    if (!host) return;
    let gone = false;
    let backlog = 0;
    const ack = new AckBatcher((n) => {
      const h = manager.handle(id);
      if (h) void h.ack(n);
      else backlog += n;
    });
    const v = runtime.create(host, {
      scrollback,
      isMac: isMac(),
      sanitizePaste,
      needsPasteConfirm,
      findUrls,
      confirmPaste,
      onLink: (url) => {
        if (isOpenableLink(url)) void runtime.openUrl(url).catch(() => undefined);
      },
      onData: (data) => {
        const h = manager.handle(id);
        if (!h) return;
        h.write(data).catch((e: unknown) => {
          if (String(e instanceof Error ? e.message : e).includes("no such terminal")) {
            manager.markExited(id);
            view.current?.notice("[shell exited]");
          }
        });
      },
      onResize: (c, r) => void manager.handle(id)?.resize(c, r).catch(() => undefined),
    });
    view.current = v;
    let raf = 0;
    const refit = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (visibleRef.current && host.clientWidth > 0 && host.clientHeight > 0) v.fit();
      });
    };
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(refit) : null;
    ro?.observe(host);
    const { cols, rows } = v.fit();
    void manager
      .start(id, Math.max(2, cols), Math.max(2, rows), (bytes) => v.write(bytes, () => ack.processed(bytes.length)))
      .then((h) => {
        if (!h) return;
        if (gone) return;
        if (backlog > 0) {
          void h.ack(backlog);
          backlog = 0;
        }
        if (visibleRef.current) v.focus();
      });
    return () => {
      gone = true;
      cancelAnimationFrame(raf);
      ro?.disconnect();
      ack.flush();
      v.dispose();
      view.current = null;
    };
    // The pane lives exactly as long as its tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!visible) return;
    const r = requestAnimationFrame(() => {
      view.current?.fit();
      view.current?.focus();
    });
    return () => cancelAnimationFrame(r);
  }, [visible]);

  return (
    <div className="tm-pane" id={`tm-pane-${id}`} role="tabpanel" aria-labelledby={`tm-tab-${id}`} hidden={!visible}>
      <div ref={el} className="tm-term" />
      {exited && (
        <div className="tm-exited" role="status">
          The shell has exited.
          <button type="button" className="ex-link" onClick={onRestart}>Restart</button>
        </div>
      )}
    </div>
  );
}
