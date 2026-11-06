// Box redirects here after consent (SP6 sync). It strips the query from the address bar and history, hands
// { state, code, error } to the LLM-IDE page that opened this popup (same origin only, SP7's BroadcastChannel, where
// waitForCode takes only its own state), and closes. An "i." state is the iPhone fallback (SP6 D7): forward to the app's
// scheme. The code is single use and needs the app secret, which only the opener holds. It stores nothing.
(function () {
  var q = location.search.slice(1);
  history.replaceState(null, "", location.pathname);
  var p = new URLSearchParams(q);
  if ((p.get("state") || "").indexOf("i.") === 0) { location.replace("llmide-box://oauth?" + q); return; }
  var ch = new BroadcastChannel("llmide-oauth");
  ch.postMessage({ state: p.get("state"), code: p.get("code"), error: p.get("error") });
  ch.close();
  setTimeout(function () { window.close(); }, 300);
})();
