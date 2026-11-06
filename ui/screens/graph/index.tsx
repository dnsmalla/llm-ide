// Code Graph section entry: the shell lazy-loads this module (default export, SectionProps) and keeps it
// mounted while other sections are shown. The section has the Mac's two pages — System (default) and Code graph —
// behind a segmented toggle; only the selected page is mounted, so the System page's change feed and the graph
// worker stop while the other one is showing.
import "@llmide/ui-kit/styles.css";
import "./graph.css";
import { Suspense, lazy, useMemo, useState } from "react";
import { notifyTask } from "../shell/notify/notify";
import { invokeHost, shellBus } from "@llmide/screens/shell";
import type { SectionProps } from "@llmide/screens/shell";
import { LayoutEngine } from "./engine.ts";
import { GraphScreen } from "./GraphScreen";
import { GraphStore } from "./store.ts";
import { readGraphPage, storeGraphPage } from "./page.ts";
import type { WorkerLike } from "./protocol.ts";
import wasmUrl from "./wasm/graph-layout.wasm?url";

const SystemPage = lazy(() => import("./SystemPage"));

export { GraphScreen, type GraphScreenProps } from "./GraphScreen";
export { GraphStore } from "./store.ts";
export { readGraphPage, storeGraphPage, type GraphPage } from "./page.ts";

let singleton: GraphStore | null = null;

function app(): GraphStore {
  if (!singleton) {
    const engine = new LayoutEngine({
      wasmUrl,
      createWorker: () => new Worker(new URL("./worker/graph.worker.ts", import.meta.url), { type: "module" }) as unknown as WorkerLike,
    });
    singleton = new GraphStore({ invoke: (cmd, args) => invokeHost(cmd, args), engine });
  }
  return singleton;
}

function CodeGraphPage({ active, projectRoot }: SectionProps) {
  const store = useMemo(app, []);
  return (
    <GraphScreen
      store={store}
      active={active}
      projectRoot={projectRoot}
      onGenerate={async (mode, target) => {
        try { await invokeHost("graph_generate", { mode, target: target || null }); void notifyTask("graph", true); }
        catch (e) { void notifyTask("graph", false); throw e; }
      }}
      onCancel={() => { void invokeHost("graph_cancel").catch(() => undefined); }}
      openFile={(path) => shellBus.publish({ type: "open-file", path })}
    />
  );
}

export default function CodeGraph({ active, projectRoot }: SectionProps) {
  const [page, setPage] = useState(readGraphPage);
  const choose = (next: "system" | "code") => {
    setPage(next);
    storeGraphPage(next);
  };
  return (
    <div className="gr-section" data-active={active}>
      <div className="gr-pagebar" role="tablist" aria-label="Graph page">
        <button type="button" role="tab" id="gr-page-system" aria-selected={page === "system"} aria-controls="gr-page-panel" className="gr-tab" onClick={() => choose("system")}>System</button>
        <button type="button" role="tab" id="gr-page-code" aria-selected={page === "code"} aria-controls="gr-page-panel" className="gr-tab" onClick={() => choose("code")}>Code graph</button>
      </div>
      <div id="gr-page-panel" role="tabpanel" aria-labelledby={page === "system" ? "gr-page-system" : "gr-page-code"} className="gr-page-panel">
        {page === "system" ? (
          <Suspense fallback={<div className="gr-root" data-active={active}><p className="gr-muted" role="status">Loading the System page…</p></div>}>
            <SystemPage active={active} projectRoot={projectRoot} onOpenCodeGraph={() => choose("code")} />
          </Suspense>
        ) : (
          <CodeGraphPage active={active} projectRoot={projectRoot} />
        )}
      </div>
    </div>
  );
}
