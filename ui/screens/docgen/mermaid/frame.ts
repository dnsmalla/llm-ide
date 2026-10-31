// The sandboxed frame's document. Built by the parent as a `srcdoc` string: runtime inlined (the host-verified
// mermaid.min.js), then a fixed boot script. NOTHING user- or model-controlled is ever interpolated into this HTML:
// the diagram text arrives later by postMessage.
//
// Containment, in layers:
//  1. `<iframe sandbox="allow-scripts">` (set by the renderer): opaque origin, no same-origin, forms, popups, top
//     navigation or downloads;
//  2. a meta CSP in this document: default-src 'none', scripts only by SHA-256 of the two inline scripts, no connect,
//     no frames, no base, no form actions, images/fonts only as data:;
//  3. the app's own CSP also applies to a srcdoc frame (inherited), and it lists the same two hashes: so even the
//     inherited policy admits exactly the pinned runtime and this boot script, nothing else;
//  4. mermaid config: securityLevel strict, htmlLabels off, startOnLoad off, and a `secure` list so no in-text
//     directive may change those keys; the level is re-read after every render and the result refused if it moved;
//  5. the PARENT sanitises the SVG again (svg-sanitize.ts) and shows it as an <img>.

/** The fixed boot script. Changing one byte changes its hash: `tauri.conf.json` pins it (check-csp.test.mjs). */
export const BOOT_JS = `(function () {
  "use strict";
  var CFG = {
    startOnLoad: false,
    securityLevel: "strict",
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    maxTextSize: 100000,
    maxEdges: 500,
    suppressErrorRendering: true,
    logLevel: 5,
    secure: ["secure", "securityLevel", "startOnLoad", "maxTextSize", "maxEdges", "htmlLabels", "theme", "themeVariables", "fontFamily", "flowchart", "suppressErrorRendering", "logLevel"]
  };
  function post(m) { parent.postMessage(m, "*"); }
  var mm = globalThis.mermaid;
  if (!mm || typeof mm.render !== "function" || typeof mm.initialize !== "function") {
    post({ type: "fatal", message: "The diagram renderer did not load." });
    return;
  }
  function strict() {
    var c = mm.mermaidAPI && mm.mermaidAPI.getConfig ? mm.mermaidAPI.getConfig() : null;
    return !!c && c.securityLevel === "strict";
  }
  var busy = false;
  window.addEventListener("message", function (ev) {
    if (ev.source !== parent) return;
    var d = ev.data;
    if (!d || d.type !== "render" || typeof d.id !== "number" || typeof d.source !== "string") return;
    if (d.theme !== "dark" && d.theme !== "default") return;
    if (busy) return;
    busy = true;
    function fail(e) { post({ type: "error", id: d.id, message: String((e && e.message) || e || "render failed").slice(0, 300) }); }
    try {
      var cfg = {};
      for (var k in CFG) cfg[k] = CFG[k];
      cfg.theme = d.theme;
      mm.initialize(cfg);
      if (!strict()) throw new Error("The renderer is not in strict mode.");
      Promise.resolve(mm.render("mmd" + d.id, d.source)).then(function (r) {
        if (!strict()) throw new Error("The renderer left strict mode.");
        post({ type: "result", id: d.id, svg: String((r && r.svg) || "") });
      }).catch(fail).then(function () { busy = false; });
    } catch (e) {
      fail(e);
      busy = false;
    }
  });
  post({ type: "ready" });
})();`;

export async function sha256Base64(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  let bin = "";
  for (const b of digest) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** The frame's CSP. Hashes are base64 SHA-256 of the exact inline script texts. */
export function frameCsp(runtimeHash: string, bootHash: string): string {
  return [
    "default-src 'none'",
    `script-src 'sha256-${runtimeHash}' 'sha256-${bootHash}'`,
    "style-src 'unsafe-inline'",
    "img-src data:",
    "font-src data:",
    "connect-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

const HASH_RE = /^[A-Za-z0-9+/]{43}=$/;

/**
 * The srcdoc. `runtimeJs` must be the host-verified file text; `runtimeHash` its base64 SHA-256 (the pin's
 * `sha256_base64`, which the caller checks against the pin before calling).
 */
export function buildSrcdoc(runtimeJs: string, runtimeHash: string, bootHash: string): string {
  if (!HASH_RE.test(runtimeHash) || !HASH_RE.test(bootHash)) throw new Error("bad script hash");
  // Inlining is only safe when the text cannot close its own element or open a nested script (`<!--` + `<script`).
  if (/<\/?script/i.test(runtimeJs)) throw new Error("runtime cannot be inlined safely");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${frameCsp(runtimeHash, bootHash)}"><style>html,body{margin:0;padding:0}</style></head><body><script>${runtimeJs}</script><script>${BOOT_JS}</script></body></html>`;
}
