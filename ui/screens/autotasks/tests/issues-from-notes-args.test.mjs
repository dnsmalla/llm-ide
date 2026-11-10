import { test } from "node:test";
import assert from "node:assert/strict";
import * as m from "../native/model.ts";

const repo = (url, active) => ({ id: url, displayName: url, url, clonePath: "/clone", active });
const config = (over = {}) => ({ primary: null, gitlabBaseUrl: "https://gitlab.com", operations: {}, saved: { github: [], gitlab: [] }, ...over });

test("Sources -> Issue files into the active saved repository, named as the Issues board names it", () => {
  assert.deepEqual(m.issuesFromNotesArgs(config({ saved: { github: [repo("https://github.com/o/r", true)], gitlab: [] } })), { provider: "github", repo: "o/r" });
  assert.deepEqual(m.issuesFromNotesArgs(config({ saved: { github: [], gitlab: [repo("https://gitlab.com/g/sub/p", true)] } })), { provider: "gitlab", repo: "g/sub/p" });
});

test("no active repository, or an unreadable URL, gives no arguments (the run is refused before any request)", () => {
  assert.equal(m.issuesFromNotesArgs(config({ saved: { github: [repo("https://github.com/o/r", false)], gitlab: [] } })), null);
  assert.equal(m.issuesFromNotesArgs(config()), null);
});

test("when both providers have an active repository, the primary provider's wins", () => {
  const both = { github: [repo("https://github.com/o/r", true)], gitlab: [repo("https://gitlab.com/g/p", true)] };
  assert.equal(m.issuesFromNotesArgs(config({ primary: "github", saved: both })).provider, "github");
  assert.equal(m.issuesFromNotesArgs(config({ primary: "gitlab", saved: both })).provider, "gitlab");
});

test("a task whose registry schedule is none is never scheduled, even armed (D17)", () => {
  assert.equal(m.isSchedulable("issues.from_notes"), false);
  assert.equal(m.isSchedulable("sourceUpdate"), true);
  const armed = { enabled: true, scheduleActive: true };
  assert.equal(m.scheduledRunAllowed("issues.from_notes", armed, true), false);
});
