// History of generated documents (the files in llm-doc/generated), newest first, windowed.
import { useEffect, useState, type ReactNode } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import type { FsApi } from "../explorer/fs";
import { describeFailure, isCancel } from "./errors.ts";
import { loadHistory, type HistoryItem, type HistoryResult } from "./history.ts";
import { formatBytes } from "./model.ts";
import { GENERATED_DIR } from "./naming.ts";
import { VirtualList } from "./VirtualList";

export interface HistoryPanelProps {
  fs: Pick<FsApi, "list"> | null;
  /** Changes when a document was saved, to reload. */
  version: string;
  active: boolean;
  onOpen: (path: string) => void;
  initialViewport?: number;
}

type State = { phase: "idle" } | { phase: "loading" } | { phase: "ready"; r: HistoryResult } | { phase: "error"; message: string };

export function formatWhen(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function HistoryPanel({ fs, version, active, onOpen, initialViewport }: HistoryPanelProps): ReactNode {
  const [s, setS] = useState<State>({ phase: "idle" });
  useEffect(() => {
    if (!fs || !active) return;
    const ctl = new AbortController();
    setS((old) => (old.phase === "ready" ? old : { phase: "loading" }));
    loadHistory(fs, ctl.signal).then(
      (r) => !ctl.signal.aborted && setS({ phase: "ready", r }),
      (e: unknown) => !ctl.signal.aborted && !isCancel(e) && setS({ phase: "error", message: describeFailure(e).message }),
    );
    return () => ctl.abort();
  }, [fs, active, version]);
  if (!fs) return <p className="dg-muted">History needs the desktop app.</p>;
  if (s.phase === "idle" || s.phase === "loading") {
    return (
      <p className="dg-muted" role="status" aria-live="polite">
        Loading history…
      </p>
    );
  }
  if (s.phase === "error") return <StatusBanner severity="error" message={<>{s.message}</>} />;
  if (s.r.missing || s.r.items.length === 0) return <p className="dg-muted">Nothing generated yet. Saved documents are listed here from <code>{GENERATED_DIR}</code>.</p>;
  return (
    <div className="dg-history">
      <p className="dg-muted" role="status">
        {s.r.items.length.toLocaleString("en")} documents{s.r.capped ? " (newest shown; the folder holds more)" : ""}
      </p>
      <VirtualList
        items={s.r.items}
        rowHeight={34}
        height={320}
        label="Generated documents"
        initialViewport={initialViewport}
        keyOf={(i: HistoryItem) => i.path}
        render={(i: HistoryItem) => (
          <button type="button" className="dg-rowbtn" onClick={() => onOpen(i.path)} aria-label={`Open ${i.name} in Explorer`}>
            <span className="dg-name">{i.name}</span>
            <span className="dg-muted">
              {formatWhen(i.mtimeMs)} · {formatBytes(i.size)}
            </span>
          </button>
        )}
      />
    </div>
  );
}
