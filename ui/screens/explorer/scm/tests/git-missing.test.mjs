// A server without git: the Changes panel shows that as its empty state, not as an error toast.
import { test } from "node:test";
import assert from "node:assert/strict";
import { load, React, renderToStaticMarkup } from "../../tests/helpers.mjs";
import { ScmErr, makeScm } from "./fakes.mjs";

const h = React.createElement;
const { ScmController } = await load("scm/controller.ts");
const { ScmPanel } = await load("scm/ScmPanel.tsx");
const { describeError } = await load("scm/model.ts");

const WORDING = "git is not installed on this server.";

test("git_missing is described as the panel's empty state with the server wording", () => {
  assert.equal(describeError("git_missing", "anything the host says").title, WORDING);
});

test("git_missing: the Changes panel shows the empty state and no error toast", async () => {
  const api = makeScm({});
  api.state.failNext = new ScmErr("git_missing", "git is not installed on this server.");
  const c = new ScmController({ api });
  await c.init("/srv/proj");
  const snap = c.getSnapshot();
  assert.equal(snap.notice, null, "no toast");
  assert.equal(snap.fatal?.code, "git_missing");
  const out = renderToStaticMarkup(h(ScmPanel, { projectRoot: "/srv/proj", onOpenFile() {}, onOpenDiff() {}, controller: c }));
  assert.match(out, /git is not installed on this server\./);
  assert.doesNotMatch(out, /Git reported a problem/);
});
