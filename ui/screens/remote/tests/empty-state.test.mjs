// The Remote section's empty state. The section offers no way to add a host, so it says there are none yet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { load, React, renderToStaticMarkup } from "../../shell/tests/helpers.mjs";

test("Remote with no workspace: says there are no remote hosts yet, and does not promise an add action", async () => {
  const remote = await load("../remote/index.tsx");
  const html = renderToStaticMarkup(React.createElement(remote.default, { active: true, projectRoot: null, mode: "local" }));
  assert.match(html, /No remote hosts yet\./);
  assert.doesNotMatch(html, /Add or open a remote host/);
});
