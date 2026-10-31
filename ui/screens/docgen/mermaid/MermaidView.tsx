// A ```mermaid fence. It ALWAYS shows the diagram source as plain text first; nothing is rendered until the runtime
// is installed (the user's explicit click, confirmed in a native dialog) and then only inside the sandboxed frame,
// as sanitised SVG in an <img>. It never renders (or even reads the runtime) on mount for a user who has not
// installed it: mount only asks the host for the install STATUS.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { prefilterMermaid } from "./source.ts";
import { sharedRender, type DiagramRender, type MermaidRuntimeApi } from "./renderer.ts";
import type { MermaidTheme } from "./protocol.ts";

type Phase =
  | { t: "checking" }
  | { t: "absent"; sizeBytes: number; version: string; installing: boolean; error: string | null }
  | { t: "rendering" }
  | { t: "done"; url: string }
  | { t: "error"; message: string };

export interface MermaidViewProps {
  source: string;
  runtime: MermaidRuntimeApi;
  /** Test seam; the app uses the sandboxed-frame renderer. */
  render?: DiagramRender;
}

const listeners = new Set<() => void>();

function currentTheme(): MermaidTheme {
  try {
    return document.documentElement.getAttribute("data-theme") === "light" ? "default" : "dark";
  } catch {
    return "dark";
  }
}

const kb = (n: number) => Math.max(1, Math.round(n / 1024)).toLocaleString("en");

export function MermaidView({ source, runtime, render }: MermaidViewProps): ReactNode {
  const [phase, setPhase] = useState<Phase>({ t: "checking" });
  const [tick, setTick] = useState(0);
  const urlRef = useRef<string | null>(null);

  // Install status only: no runtime read, no render.
  useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    listeners.add(bump);
    return () => void listeners.delete(bump);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const signal = { aborted: false };
    const revoke = () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    };
    (async () => {
      let st;
      try {
        st = await runtime.status();
      } catch {
        if (!cancelled) setPhase({ t: "absent", sizeBytes: 0, version: "", installing: false, error: "The diagram renderer is unavailable here." });
        return;
      }
      if (cancelled) return;
      if (!st.installed) {
        setPhase((p) => (p.t === "absent" ? { ...p, sizeBytes: st.sizeBytes, version: st.version } : { t: "absent", sizeBytes: st.sizeBytes, version: st.version, installing: false, error: null }));
        return;
      }
      const pre = prefilterMermaid(source);
      if (!pre.ok) {
        setPhase({ t: "error", message: pre.reason });
        return;
      }
      setPhase({ t: "rendering" });
      try {
        const svg = await (render ?? sharedRender(runtime))(source, currentTheme(), signal);
        if (cancelled) return;
        revoke();
        urlRef.current = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
        setPhase({ t: "done", url: urlRef.current });
      } catch (e) {
        if (!cancelled) setPhase({ t: "error", message: e instanceof Error ? e.message : "The diagram could not be rendered." });
      }
    })();
    return () => {
      cancelled = true;
      signal.aborted = true;
      revoke();
    };
  }, [source, runtime, render, tick]);

  const install = useCallback(async () => {
    setPhase((p) => (p.t === "absent" ? { ...p, installing: true, error: null } : p));
    try {
      const st = await runtime.install();
      if (st.installed) listeners.forEach((l) => l());
      else setPhase((p) => (p.t === "absent" ? { ...p, installing: false } : p));
    } catch (e) {
      const message = e instanceof Error ? e.message : "The install failed.";
      setPhase((p) => (p.t === "absent" ? { ...p, installing: false, error: message } : p));
    }
  }, [runtime]);

  const showSource = phase.t !== "done";
  return (
    <figure className="lib-code dg-mermaid">
      <figcaption>{phase.t === "done" ? "mermaid diagram" : "mermaid (diagram source)"}</figcaption>
      {phase.t === "done" && <img className="dg-mermaid-img" src={phase.url} alt="Rendered diagram" />}
      {showSource && (
        <pre tabIndex={0}>
          <code>{source}</code>
        </pre>
      )}
      {phase.t === "absent" && (
        <div className="dg-mermaid-bar">
          <button type="button" className="dg-btn" disabled={phase.installing} onClick={() => void install()}>
            {phase.installing ? "Installing…" : `Install diagram renderer (about ${kb(phase.sizeBytes || 3_572_661)} KB, once)`}
          </button>
          <span className="dg-muted">Downloads once from cdn.jsdelivr.net after you confirm; checksum verified; stored in app data.</span>
          {phase.error && <span role="alert" className="dg-muted">{phase.error}</span>}
        </div>
      )}
      {phase.t === "rendering" && <p className="dg-muted" role="status">Rendering diagram…</p>}
      {phase.t === "error" && <p className="dg-muted" role="alert">Showing the source: {phase.message}</p>}
    </figure>
  );
}
