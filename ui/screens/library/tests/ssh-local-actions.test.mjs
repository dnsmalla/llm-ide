// SSH server mode: the Library's "Reveal in Finder" actions are not offered (the reveal command is refused there).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileManagerRevealFor, projectLocationReveal } from "../local-actions.ts";
import { loadEntry, react, server } from "./helpers.mjs";

const L = await loadEntry();
const h = react().createElement;
const html = (el) => server().renderToStaticMarkup(el);

test("Library reveal: offered outside ssh mode and sends the project-relative path", async () => {
  const sent = [];
  const reveal = fileManagerRevealFor(false, async (rel) => { sent.push(rel); });
  assert.equal(typeof reveal, "function");
  await reveal("llm-doc/notes/a.md");
  assert.deepEqual(sent, ["llm-doc/notes/a.md"]);
});

test("Library reveal: no handler in ssh mode", () => {
  assert.equal(fileManagerRevealFor(true, async () => { throw new Error("must not run"); }), undefined);
});

// The note menu is rendered through the component that draws it, so the check is on the markup a user sees.
const menu = (over = {}) => html(h(L.NoteMenuItems, { rel: "a.md", hidden: false, onOpen() {}, onUnhide() {}, onRemove() {}, onClose() {}, ...over }));

test("note menu: Reveal in Finder is drawn in local mode and absent in ssh mode", async () => {
  const local = menu({ onRevealPath: fileManagerRevealFor(false, async () => undefined) });
  assert.match(local, /role="menuitem"[^>]*>Reveal in Finder</);
  const ssh = menu({ onRevealPath: fileManagerRevealFor(true, async () => undefined) });
  assert.doesNotMatch(ssh, /Reveal in Finder/);
  // The other items stay.
  for (const label of ["Open", "Copy relative path", "Remove from List"]) assert.match(ssh, new RegExp(`>${label}<`));
});

test("note menu: a hidden note offers Unhide, and the reveal item follows the same rule", () => {
  const hidden = menu({ hidden: true });
  assert.match(hidden, />Unhide</);
  assert.doesNotMatch(hidden, /Reveal in Finder/, "no handler, no item");
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

// SSH server mode: "Choose folder…" and "Export" act on this computer, so the Library does not offer them.
import { libraryChooseFor, exportFileFor } from "../local-actions.ts";

test("Library folder choice: offered outside ssh mode; ssh mode offers none", () => {
  const choose = () => undefined;
  assert.equal(libraryChooseFor(false, choose), choose);
  assert.equal(libraryChooseFor(true, choose), null);
});

test("Library export: offered outside ssh mode; ssh mode offers none", () => {
  const exportNote = async () => "/x.md";
  assert.equal(exportFileFor(false, exportNote), exportNote);
  assert.equal(exportFileFor(true, exportNote), undefined);
});

test("no-folder card: the Choose folder button is drawn only when a choice is offered", () => {
  const withChoice = html(h(L.NoFolder, { onChoose() {}, error: null, hostAvailable: true }));
  assert.match(withChoice, />Choose folder…</);
  const ssh = html(h(L.NoFolder, { onChoose: undefined, error: null, hostAvailable: true }));
  assert.doesNotMatch(ssh, /Choose folder/);
});
