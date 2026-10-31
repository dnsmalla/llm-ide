import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { emitBench, waitVisibleAndPainted } from "../editor/editorBench";
import { EditorTabBar } from "@llmide/ui-kit";
import { spawnShell, type PtyHandle } from "../terminal/ptyClient";
import { OutputPump } from "../terminal/outputPump";
import { terminalFont, xtermTheme } from "../terminal/xtermTheme";
import { runTerminalBench, type TerminalReady } from "../terminal/termBench";
import { claimStep, finishStep } from "../bench/runner";

/** Must stay well below the Rust HIGH_WATER (1 MiB) in pty.rs. */
const ACK_CHUNK_BYTES = 128 * 1024;

/** Autobench hard limit: if the bench has not finished by then, report and exit. */
const WATCHDOG_MS = 120_000;

// Module-level guard: StrictMode runs effects twice in development.
let watchdogStarted = false;

export function TerminalView() {
  const host = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState<TerminalReady | null>(null);

  // Create the terminal and start the shell once per mount. Creation waits for a visible,
  // painted window: a background WKWebView does not run timers or rAF, and the bench must
  // not start inside that window.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let cancelled = false;
    let term: Terminal | null = null;
    let handle: PtyHandle | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let themeObserver: MutationObserver | null = null;
    const disposables: Array<{ dispose(): void }> = [];

    void (async () => {
      const visibleWaitMs = await waitVisibleAndPainted();
      if (cancelled) return;
      const t = new Terminal({ ...terminalFont(), theme: xtermTheme(), cursorBlink: true, scrollback: 5000 });
      term = t;
      const fit = new FitAddon();
      t.loadAddon(fit);
      t.open(el);
      // WebGL draws to a canvas; the DOM renderer draws none. Tell them apart after open.
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        t.loadAddon(webgl);
      } catch {
        // no WebGL2: xterm keeps the DOM renderer
      }
      const renderer = el.querySelector("canvas") ? "webgl" : "dom";
      fit.fit();

      const pump = new OutputPump(t);
      const h = await spawnShell(t.cols, t.rows, (bytes) => pump.push(bytes));
      handle = h;
      // Flow control: report parsed bytes in chunks so Rust can pause a flooding shell.
      let unacked = 0;
      pump.onProcessed = (n) => {
        unacked += n;
        if (unacked >= ACK_CHUNK_BYTES) {
          const credit = unacked;
          unacked = 0;
          void h.ack(credit);
        }
      };
      if (cancelled) {
        await h.kill();
        return;
      }
      disposables.push(t.onData((data) => void h.write(data)));
      disposables.push(t.onResize(({ cols, rows }) => void h.resize(cols, rows)));
      resizeObserver = new ResizeObserver(() => fit.fit());
      resizeObserver.observe(el);
      themeObserver = new MutationObserver(() => {
        t.options.theme = xtermTheme();
      });
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
      t.focus();
      setReady({ term: t, handle: h, shell: h.shell, pump, visibleWaitMs, renderer });
    })();

    return () => {
      cancelled = true;
      resizeObserver?.disconnect();
      themeObserver?.disconnect();
      for (const d of disposables) d.dispose();
      term?.dispose();
      void handle?.kill();
    };
  }, []);

  // LLMIDE_POC_AUTOBENCH=terminal: run only the terminal bench, then exit through bench_done.
  // Outside the try, so a normal launch never reaches the exit call.
  useEffect(() => {
    if (!ready) return;
    void (async () => {
      const mode = await invoke<string | null>("autobench_mode").catch(() => null);
      const start = claimStep("terminal", mode);
      if (!start) return;
      let error: string | undefined;
      try {
        await runTerminalBench(ready);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        await emitBench({ name: "term_error", value: 0, unit: "error", message: error }).catch(() => undefined);
      } finally {
        await ready.handle.kill();
        await finishStep(start, "terminal", error);
      }
    })();
  }, [ready]);

  // Watchdog: in terminal autobench mode, a hang becomes a term_error and an exit.
  useEffect(() => {
    if (watchdogStarted) return;
    watchdogStarted = true;
    void invoke<string | null>("autobench_mode")
      .catch(() => null)
      .then((mode) => {
        if (mode !== "terminal") return;
        setTimeout(() => {
          void emitBench({ name: "term_error", value: 0, unit: "error", message: `watchdog: bench not finished after ${WATCHDOG_MS} ms` })
            .catch(() => undefined)
            .finally(() => void invoke("bench_done").catch(() => undefined));
        }, WATCHDOG_MS);
      });
  }, []);

  // Tab label: the shell's basename once it has spawned ("shell" until then).
  const tabLabel = ready?.shell ?? "shell";
  return (
    <section className="terminal-view">
      <EditorTabBar
        tabs={[{ id: tabLabel, label: tabLabel }]}
        activeId={tabLabel}
        onSelect={() => undefined}
        onClose={() => undefined}
      />
      <div ref={host} className="terminal-host" onClick={() => ready?.term.focus()} />
    </section>
  );
}
