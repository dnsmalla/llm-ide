// Monaco setup: workers come from Vite (`?worker`), so nothing is fetched from a CDN
// and the CSP needs no script-src change. Imported first by anything that uses Monaco.
// The package's main entry: its editor and TypeScript registrations share one service set.
// (The editor.api + contribution subpaths did not wire the TypeScript mode in this build.)
import * as monaco from "monaco-editor";

// Same module instance as the index's TypeScript contribution (one file, one registration).
export { getTypeScriptWorker } from "monaco-editor/language/typescript/monaco.contribution.js";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker.js?worker";

type MonacoGlobal = { MonacoEnvironment?: { getWorker(id: string, label: string): Worker } };

// Worker bookkeeping for the bench: created count and uncaught worker errors (a worker
// that needs a blocked capability, e.g. eval under this CSP, fails through onerror).
const workers = { created: 0, errors: 0 };

(self as unknown as MonacoGlobal).MonacoEnvironment = {
  getWorker(_id, label) {
    workers.created += 1;
    const worker = label === "typescript" || label === "javascript" ? new TsWorker() : new EditorWorker();
    worker.onerror = () => {
      workers.errors += 1;
    };
    return worker;
  },
};

export function workerStats(): { created: number; errors: number } {
  return { ...workers };
}

export { monaco };
