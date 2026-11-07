// The header route chip names the chat's pinned model, as the Mac's ChatRouteControl did ("Route" when unpinned).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadChat, h, renderToStaticMarkup as html } from "./helpers.mjs";

let c;
before(async () => { c = await loadChat("route-chip"); });

const used = (billable, cacheRead = 0) => ({ in: 0, out: 0, cacheWrite: 0, cacheRead, billable });

test("capChipText: pinned model or Route, then the meter once a limit is set or tokens were used", () => {
  assert.equal(c.capChipText({ pinned: false, model: "", tokenLimit: null, used: used(0) }), "Route");
  assert.equal(c.capChipText({ pinned: true, model: "glm-5", tokenLimit: null, used: used(0) }), "glm-5");
  assert.equal(c.capChipText({ pinned: true, model: "glm-5", tokenLimit: 50000, used: used(45000) }), "glm-5 · 45k / 50k");
  assert.equal(c.capChipText({ pinned: false, model: "x", tokenLimit: null, used: used(1200, 90000) }), "Route · 1.2k (+90k cached reads)");
});

test("the chip shows the pinned model and keeps its token-limit label", () => {
  const route = { enabled: true, capEnforced: true, chatSessionId: "a", provider: "custom:ac-glm", model: "glm-5", pinned: true, tokenLimit: 50000, used: used(45000), remaining: 5000, switchSeq: 1 };
  const out = html(h(c.CapChip, { route, onSetLimit: () => {} }));
  assert.match(out, />glm-5 · 45k \/ 50k<\/button>/);
  assert.match(out, /aria-label="Token limit 45k \/ 50k"/);
  assert.match(out, /title="This chat&#x27;s model and token limit"/);
});
