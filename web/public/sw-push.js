// Push text for the web app's worker (push notifications plan): the words of desktop/src-tauri/src/notify.rs
// Kind::body, keyed by kind. A push carries {k, n} only; anything else shows nothing.
// extension/tests/push-kinds.test.mjs checks this table against notify.rs.
self.LLMIDEPush = (() => {
  const ONE = {
    approval_chat: "A tool is waiting for your approval in Chat.",
    approval_job: "A job is waiting for your approval.",
    loop_done: "A Loop run passed.",
    loop_failed: "A Loop run did not pass.",
    autotask_done: "An Auto Task finished.",
    autotask_failed: "An Auto Task did not complete.",
    graph_done: "The code graph is ready.",
    graph_failed: "Code graph generation failed.",
    docgen_done: "A generated document is ready.",
    docgen_failed: "Document generation failed.",
    sync_attention: "Sync needs your attention in Settings.",
  };
  const MANY = {
    approval_chat: "{n} tools are waiting for your approval in Chat.",
    approval_job: "{n} jobs are waiting for your approval.",
  };
  const has = (o, k) => typeof k === "string" && Object.prototype.hasOwnProperty.call(o, k);
  function render(data) {
    if (!data || typeof data !== "object" || !has(ONE, data.k)) return null;
    const n = Number.isInteger(data.n) && data.n > 0 ? data.n : 1;
    const body = n > 1 && has(MANY, data.k) ? MANY[data.k].replace("{n}", n > 99 ? "99+" : String(n)) : ONE[data.k];
    return { title: "LLM-IDE", body, tag: data.k };
  }
  return { ONE, MANY, render };
})();
