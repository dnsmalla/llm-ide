// Pure helpers for the app-shell worker; importScripts()-loaded so they can be tested in Node.
(function (g) {
  "use strict";
  /** Asset URLs referenced by the current index.html (Vite emits src/href="/assets/..."). */
  function assetsInIndex(html) {
    const out = new Set();
    for (const m of String(html).matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)) out.add(m[1]);
    return [...out];
  }
  /** Cached request URLs that are hashed assets but not referenced by the current build. */
  function staleAssetPaths(cachedUrls, keep) {
    const alive = new Set(keep);
    const out = [];
    for (const raw of cachedUrls) {
      let path;
      try { path = new URL(raw).pathname; } catch { continue; }
      if (path.startsWith("/assets/") && !alive.has(path)) out.push(raw);
    }
    return out;
  }
  g.LLMIDESwPrune = { assetsInIndex, staleAssetPaths };
})(self);
