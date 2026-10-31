// Diagnostics: the last core request outcomes + core status essentials, as text a user can copy into a bug report.
// Opened from the status bar's core chip and from Settings > About. Plain text only; no secrets (see diagnostics.ts).
import { useMemo, useState, useSyncExternalStore } from "react";
import { coreStatusStore } from "./runtime";
import { diagnosticsLog, buildDiagnosticsReport } from "./diagnostics";
import { useCoreSession } from "./use-shell";
import { useStoreSelector } from "./hooks";

declare const __APP_VERSION__: string | undefined;

const mono = { fontFamily: "var(--tok-font-mono, monospace)", fontSize: "12px", whiteSpace: "pre-wrap", wordBreak: "break-word", margin: 0, maxHeight: "40vh", overflow: "auto", padding: "8px", border: "1px solid var(--tok-color-border, #8884)", borderRadius: "6px" } as const;

export function DiagnosticsPanel({ onClose }: { onClose?: () => void }) {
  useSyncExternalStore(diagnosticsLog.subscribe, diagnosticsLog.version, diagnosticsLog.version);
  const status = useStoreSelector(coreStatusStore, (s) => s.status);
  const { signedIn } = useCoreSession();
  const [note, setNote] = useState<string | null>(null);
  const appVersion = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";
  const entries = diagnosticsLog.entries();
  const text = useMemo(() => buildDiagnosticsReport({ status, signedIn, appVersion, entries }), [status, signedIn, appVersion, entries]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setNote("Copied. It holds states and request outcomes only, no keys, tokens or bodies.");
    } catch {
      setNote("Could not copy. Select the text and copy it by hand.");
    }
  };
  return (
    <section role="dialog" aria-label="Core diagnostics" style={{ display: "grid", gap: "8px", padding: "12px", background: "var(--tok-color-surface, Canvas)", color: "var(--tok-color-text, CanvasText)", border: "1px solid var(--tok-color-border, #8884)", borderRadius: "8px", maxWidth: "min(640px, 94vw)" }}>
      <strong>Core diagnostics</strong>
      <pre style={mono} tabIndex={0}>{text}</pre>
      <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
        <button type="button" onClick={() => void copy()}>Copy diagnostics</button>
        <button type="button" onClick={() => { diagnosticsLog.clear(); setNote(null); }}>Clear</button>
        {onClose ? <button type="button" onClick={onClose}>Close</button> : null}
        {note ? <span role="status">{note}</span> : null}
      </div>
    </section>
  );
}
