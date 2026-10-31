// Code Graph section entry: the shell lazy-loads this module (default export, SectionProps) and keeps it
// mounted while other sections are shown. The store, worker engine and layout cache live for the app's
// lifetime (the cache is bounded); the WebGL view is created only while the section is visible.
import "@llmide/ui-kit/styles.css";
import "./graph.css";
import { useMemo } from "react";
import { invokeHost, shellBus } from "@llmide/screens/shell";
import type { SectionProps } from "@llmide/screens/shell";
import { LayoutEngine } from "./engine.ts";
import { GraphScreen } from "./GraphScreen";
import { GraphStore } from "./store.ts";
import type { WorkerLike } from "./protocol.ts";
import wasmUrl from "./wasm/graph-layout.wasm?url";

export { GraphScreen, type GraphScreenProps } from "./GraphScreen";
export { GraphStore } from "./store.ts";

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

export default function CodeGraph({ active, projectRoot }: SectionProps) {
  const store = useMemo(app, []);
  return <GraphScreen store={store} active={active} projectRoot={projectRoot} openFile={(path) => shellBus.publish({ type: "open-file", path })} />;
}
