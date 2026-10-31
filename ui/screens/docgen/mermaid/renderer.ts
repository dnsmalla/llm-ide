// Renders one diagram in a throwaway sandboxed iframe and returns SANITISED SVG text. DOM-dependent, so only a real
// window exercises it (see docs). The pure parts it relies on (pre-filter, protocol, queue, sanitiser, srcdoc) are
// tested without a browser.
import { buildSrcdoc, BOOT_JS, sha256Base64 } from "./frame.ts";
import { parseFrameMessage, renderMessage, RENDER_TIMEOUT_MS, type MermaidTheme } from "./protocol.ts";
import { RenderQueue, withTimeout } from "./queue.ts";
import { prefilterMermaid } from "./source.ts";
import { sanitizeSvg } from "./svg-sanitize.ts";

export interface MermaidRuntimeApi {
  status(): Promise<{ installed: boolean; version: string; sizeBytes: number }>;
  /** Asks the user (native dialog) and installs. Resolves with the new status (unchanged when declined). */
  install(): Promise<{ installed: boolean; version: string; sizeBytes: number }>;
  /** The host-verified runtime text. Rejects when not installed or when the host's integrity check fails. */
  read(): Promise<string>;
}

export type DiagramRender = (source: string, theme: MermaidTheme, signal: { aborted: boolean }) => Promise<string>;

/** Concurrent frames. Each is a full mermaid instance, so keep it small. */
export const MAX_CONCURRENT_FRAMES = 1;
const queue = new RenderQueue(MAX_CONCURRENT_FRAMES);
let nextId = 1;

export function createIframeRender(runtime: Pick<MermaidRuntimeApi, "read">, timeoutMs: number = RENDER_TIMEOUT_MS): DiagramRender {
  let srcdoc: Promise<string> | null = null;
  const getSrcdoc = () => {
    srcdoc ??= (async () => {
      const js = await runtime.read();
      return buildSrcdoc(js, await sha256Base64(js), await sha256Base64(BOOT_JS));
    })();
    srcdoc.catch(() => {
      srcdoc = null; // a failed read is retried on the next diagram
    });
    return srcdoc;
  };
  return (source, theme, signal) => {
    const pre = prefilterMermaid(source);
    if (!pre.ok) return Promise.reject(new Error(pre.reason));
    return queue.run(async () => {
      const html = await getSrcdoc();
      if (signal.aborted) throw new Error("cancelled");
      const id = nextId++;
      const iframe = document.createElement("iframe");
      let listener: ((e: MessageEvent) => void) | null = null;
      const dispose = () => {
        if (listener) window.removeEventListener("message", listener);
        listener = null;
        iframe.remove();
      };
      const done = new Promise<string>((resolve, reject) => {
        listener = (e: MessageEvent) => {
          if (e.source !== iframe.contentWindow) return;
          const m = parseFrameMessage(e.data);
          if (!m) return;
          if (m.type === "ready") iframe.contentWindow?.postMessage(renderMessage(id, pre.source, theme), "*");
          else if (m.type === "result" && m.id === id) resolve(m.svg);
          else if (m.type === "error" && m.id === id) reject(new Error(m.message));
          else if (m.type === "fatal") reject(new Error(m.message));
        };
        window.addEventListener("message", listener);
      });
      // No allow-same-origin, allow-forms, allow-popups, allow-top-navigation or allow-downloads: scripts only.
      iframe.setAttribute("sandbox", "allow-scripts");
      iframe.setAttribute("referrerpolicy", "no-referrer");
      iframe.setAttribute("aria-hidden", "true");
      iframe.setAttribute("tabindex", "-1");
      iframe.setAttribute("title", "Diagram renderer");
      iframe.style.cssText = "position:fixed;left:-20000px;top:0;width:1200px;height:900px;border:0;visibility:hidden;pointer-events:none";
      iframe.srcdoc = html;
      document.body.appendChild(iframe);
      try {
        const svg = await withTimeout(done, timeoutMs, dispose);
        const clean = sanitizeSvg(svg);
        if (!clean.ok) throw new Error(clean.reason);
        return clean.svg;
      } finally {
        dispose();
      }
    }, signal);
  };
}

const shared = new WeakMap<object, DiagramRender>();
/** One renderer (and one cached srcdoc) per runtime binding. */
export function sharedRender(runtime: MermaidRuntimeApi): DiagramRender {
  let r = shared.get(runtime);
  if (!r) {
    r = createIframeRender(runtime);
    shared.set(runtime, r);
  }
  return r;
}
