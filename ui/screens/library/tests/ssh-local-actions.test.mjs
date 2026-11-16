// SSH server mode: the Library's "Reveal in Finder" actions are not offered (the reveal command is refused there).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileManagerRevealFor, projectLocationReveal } from "../local-actions.ts";

test("Library reveal: offered outside ssh mode and sends the project-relative path", async () => {
  const sent = [];
  const reveal = fileManagerRevealFor(false, async (rel) => { sent.push(rel); });
  assert.equal(typeof reveal, "function");
  await reveal("llm-doc/notes/a.md");
  assert.deepEqual(sent, ["llm-doc/notes/a.md"]);
});

test("Library reveal: left out in ssh mode, so the menu item is not drawn", () => {
  assert.equal(fileManagerRevealFor(true, async () => { throw new Error("must not run"); }), undefined);
});

test("extension reveal: a location inside the project reveals outside ssh mode; ssh mode reveals nothing", () => {
  const root = () => "/Users/me/proj";
  const sent = [];
  const local = projectLocationReveal(false, root, (rel) => sent.push(rel));
  assert.equal(local.canReveal("/Users/me/proj/src/a.md"), true);
  local.reveal("/Users/me/proj/src/a.md");
  assert.deepEqual(sent, ["src/a.md"]);
  assert.equal(local.canReveal("/etc/passwd"), false);

  const ssh = projectLocationReveal(true, root, (rel) => sent.push(rel));
  assert.equal(ssh.canReveal("/Users/me/proj/src/a.md"), false);
  ssh.reveal("/Users/me/proj/src/a.md");
  assert.deepEqual(sent, ["src/a.md"], "ssh mode sent nothing");
});
