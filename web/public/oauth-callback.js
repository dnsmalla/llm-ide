// The OAuth redirect target (design 9). It removes the code from the address bar and history, hands it to the
// LLM-IDE tab that opened the sign-in (same origin only, over BroadcastChannel), and closes. It stores nothing.
(function () {
  var p = new URLSearchParams(location.search);
  history.replaceState(null, "", location.pathname);
  var msg = { state: p.get("state"), code: p.get("code"), error: p.get("error") };
  var ch = new BroadcastChannel("llmide-oauth");
  ch.postMessage(msg);
  ch.close();
  document.getElementById("s").textContent = msg.code ? "Signed in. You can close this window." : "Sign-in did not finish. You can close this window.";
  setTimeout(function () { window.close(); }, 300);
})();
