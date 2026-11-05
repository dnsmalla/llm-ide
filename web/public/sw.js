// App-shell service worker. It caches the built page and its hashed assets so the installed client opens
// offline; it never caches the Host API WebSocket, pairing data, tokens or any cross-origin response.
importScripts("sw-prune.js");

const CACHE = "llmide-shell-__SW_BUILD__";
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icons/icon-192.png", "./icons/icon-512.png", "./icons/icon-maskable-512.png", "./icons/apple-touch-icon.png"];

/** Delete hashed assets from older builds; the current index.html is the source of truth. */
async function pruneOldAssets(cache) {
  const index = (await cache.match("./index.html")) ?? (await cache.match("./"));
  if (!index) return;
  const keep = self.LLMIDESwPrune.assetsInIndex(await index.text());
  if (keep.length === 0) return;
  const keys = await cache.keys();
  for (const raw of self.LLMIDESwPrune.staleAssetPaths(keys.map((r) => r.url), keep)) {
    await cache.delete(raw);
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then(async (c) => {
    await c.addAll(SHELL);
    await pruneOldAssets(c);
    await self.skipWaiting();
  }));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // The socket is not an HTTP request; this guard is for any future HTTP core route.
  if (url.pathname.startsWith("/host-api/")) return;
  if (url.pathname.endsWith("/sw.js")) return;

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) caches.open(CACHE).then((c) => c.put("./", res.clone())).catch(() => {});
          return res;
        })
        .catch(async () => (await caches.match("./")) ?? (await caches.match("./index.html")) ?? new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain" } })),
    );
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(req);
    const network = fetch(req).then((res) => {
      if (res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone())).catch(() => {});
      return res;
    }).catch(() => cached);
    return cached ?? network;
  })());
});
