(() => {
  const q = location.search.slice(1);
  history.replaceState(null, "", location.pathname);
  const state = new URLSearchParams(q).get("state") || "";
  if (state.startsWith("i.")) { location.replace(`llmide-box://oauth?${q}`); return; }
  const ch = new BroadcastChannel("llmide-box-auth");
  ch.postMessage(q);
  ch.close();
  setTimeout(() => window.close(), 300);
})();
