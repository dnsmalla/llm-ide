// Mac parity guards for the Library's note actions. The screens are React components rendered by the
// desktop shell, so these read the source. A note's `rel` is relative to the Library root, which is
// `<project>/llm-doc` while a project is open (notes_fs.rs current_root), but `reveal_in_os` resolves
// against the PROJECT root (os_open.rs), so Copy path / Reveal must hand the host `llm-doc/<rel>`.
// Passing bare `rel` reveals `<project>/<rel>`: not_found, or a different file of the same name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const at = (rel) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");

test("copy path and reveal hand the host a project-relative path (llm-doc/<rel>)", () => {
  const ws = at("write/NoteWorkspace.tsx");
  assert.match(ws, /onCopyPath!\(`llm-doc\/\$\{rel\}`\)/);
  assert.match(ws, /onRevealPath!\(`llm-doc\/\$\{rel\}`\)/);
  const screen = at("LibraryScreen.tsx");
  assert.match(screen, /onCopyPath\?\.\(`llm-doc\/\$\{noteMenu\.rel\}`\)/);
  assert.match(screen, /onRevealPath\?\.\(`llm-doc\/\$\{noteMenu\.rel\}`\)/);
  for (const [file, src] of [["write/NoteWorkspace.tsx", ws], ["LibraryScreen.tsx", screen]]) {
    assert.ok(!/onRevealPath[!?]*\.?\((noteMenu\.)?rel\)/.test(src), `${file} must not reveal a bare notes-root rel`);
  }
});

test("⌘E exports the open note (Mac MeetingDetailView Export shortcut), not while editing", () => {
  const src = at("write/NoteWorkspace.tsx");
  assert.match(src, /e\.key\.toLowerCase\(\) === "e"\) \{ e\.preventDefault\(\); void doExport\(\);/);
  assert.match(src, /if \(!active \|\| editing \|\| exporting\) return;/);
});

test("⌘E / ⌘R are off while the Library section is hidden (the shell keeps it mounted)", () => {
  const src = at("write/NoteWorkspace.tsx");
  assert.match(src, /if \(!active \|\| !isMeeting \|\| summarising \|\| editing\) return;/);
  assert.match(at("LibraryScreen.tsx"), /<NoteWorkspace[\s\S]*?active=\{active\}[\s\S]*?\/>/);
});

test("the stale 'not available in this version' notice is gone", () => {
  assert.ok(!at("note-view.ts").includes("not available in this version"));
  assert.ok(at("note-view.ts").includes("Use Re-summarise to try again."));
});
