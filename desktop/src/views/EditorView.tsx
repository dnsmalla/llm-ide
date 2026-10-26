import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { editor as MonacoEditorNs } from "monaco-editor";
import { monaco } from "../editor/monacoEnv";
import { applyMonacoTheme, editorFontOptions, THEME_NAME } from "../editor/monacoTheme";
import { generateSampleTs } from "../editor/sampleFile";
import {
  emitBench,
  emitBenchDiagnostics,
  runEditorBench,
  waitContentRendered,
  waitVisibleAndPainted,
  type OpenTiming,
} from "../editor/editorBench";
import { EditorTabBar } from "../design/components/EditorTabBar";
import { claimStep, finishStep } from "../bench/runner";

const FILE_NAME = "sample.ts";
const MODEL_URI = "inmemory://llmide/sample.ts";
/** Autobench hard limit: if the bench has not finished by then, report and exit. */
const WATCHDOG_MS = 60_000;

// Built once per page load; generation is deterministic and not part of the open timing.
let sourceCache: string | null = null;
function sampleSource(): string {
  sourceCache ??= generateSampleTs();
  return sourceCache;
}

// Module-level guard: StrictMode runs effects twice in development.
let watchdogStarted = false;

interface Opened {
  editor: MonacoEditorNs.IStandaloneCodeEditor;
  model: MonacoEditorNs.ITextModel;
  timing: OpenTiming;
}

export function EditorView() {
  const host = useRef<HTMLDivElement>(null);
  const [opened, setOpened] = useState<Opened | null>(null);

  // Create the editor once per mount. Creation waits for a visible, painted window so the
  // open timing is not inflated by a background WKWebView (its rAF does not run hidden).
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let cancelled = false;
    let editor: MonacoEditorNs.IStandaloneCodeEditor | null = null;
    let model: MonacoEditorNs.ITextModel | null = null;
    void (async () => {
      const visibleWaitMs = await waitVisibleAndPainted();
      if (cancelled) return;
      const uri = monaco.Uri.parse(MODEL_URI);
      monaco.editor.getModel(uri)?.dispose();
      applyMonacoTheme();
      const visibilityAtT0 = document.visibilityState;
      const t0 = performance.now();
      model = monaco.editor.createModel(sampleSource(), "typescript", uri);
      editor = monaco.editor.create(el, {
        model,
        theme: THEME_NAME,
        automaticLayout: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        renderWhitespace: "none",
        smoothScrolling: false,
        ...editorFontOptions(),
      });
      const afterCreate = performance.now();
      const stop = await waitContentRendered(el);
      if (cancelled) return;
      setOpened({
        editor,
        model,
        timing: { visibleWaitMs, visibilityAtT0, t0, afterCreate, stop: stop.at, via: stop.via },
      });
    })();
    return () => {
      cancelled = true;
      editor?.dispose();
      model?.dispose();
    };
  }, []);

  // Re-theme when the app theme changes (App sets data-theme on <html>).
  useEffect(() => {
    const observer = new MutationObserver(() => applyMonacoTheme());
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  // LLMIDE_POC_AUTOBENCH=editor: run only the editor bench, then exit through bench_done.
  // Outside the try, so a normal launch never reaches the exit call.
  useEffect(() => {
    if (!opened) return;
    void (async () => {
      const mode = await invoke<string | null>("autobench_mode").catch(() => null);
      const start = claimStep("editor", mode);
      if (!start) return;
      let error: string | undefined;
      try {
        await runEditorBench(opened.editor, opened.model, opened.timing, sampleSource().length);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        await emitBench({ name: "editor_error", value: 0, unit: "error", message: error }).catch(() => undefined);
      } finally {
        await emitBenchDiagnostics().catch(() => undefined);
        await finishStep(start, "editor", error);
      }
    })();
  }, [opened]);

  // Watchdog: in editor autobench mode, a hang becomes an editor_error and an exit.
  useEffect(() => {
    if (watchdogStarted) return;
    watchdogStarted = true;
    void invoke<string | null>("autobench_mode")
      .catch(() => null)
      .then((mode) => {
        if (mode !== "editor") return;
        setTimeout(() => {
          void emitBench({ name: "editor_error", value: 0, unit: "error", message: `watchdog: bench not finished after ${WATCHDOG_MS} ms` })
            .catch(() => undefined)
            .finally(() => void invoke("bench_done").catch(() => undefined));
        }, WATCHDOG_MS);
      });
  }, []);

  return (
    <section className="editor-view">
      <EditorTabBar
        tabs={[{ id: FILE_NAME, label: FILE_NAME }]}
        activeId={FILE_NAME}
        onSelect={() => undefined}
        onClose={() => undefined}
      />
      <div ref={host} className="editor-host" />
    </section>
  );
}
