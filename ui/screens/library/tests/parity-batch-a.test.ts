// Batch A parity guards (Mac Library): Box console link, reveal of the meetings folder, note-open Retry,
// Slack Select All / Select None with removable missing channels, and the legacy saved group "month".
// The screens are React components rendered by the desktop shell, so the UI guards read the source (as in
// parity-wiring.test.mjs); the saved-group behaviour runs for real against LibraryStore.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { filtersFromPrefs, groupFromPrefs, LibraryStore } from "../library-store.ts";
import { NO_FILTERS } from "../notes-model.ts";
import { MEETINGS_REVEAL_PATHS, revealFirst } from "../project-files.ts";
import { selectAllChannels, SLACK_MAX_CHANNELS, validateSlack } from "../sources/source-config.ts";
import { FakeHost } from "./fake-host.ts";

const at = (rel: string): string => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");

/** The source of one top-level function or component: from its header to the next top-level declaration. */
const block = (src: string, header: string): string => {
  const start = src.indexOf(header);
  assert.ok(start >= 0, `missing ${header}`);
  const next = src.indexOf("\nexport ", start + header.length);
  return src.slice(start, next < 0 ? undefined : next);
};

/** A component-local arrow function: from its header to the closing "  };" at its own indent. */
const inner = (src: string, header: string): string => {
  const start = src.indexOf(header);
  assert.ok(start >= 0, `missing ${header}`);
  const end = src.indexOf("\n  };", start);
  assert.ok(end > start, `unterminated ${header}`);
  return src.slice(start, end + 5);
};

test("Box: the developer console link opens the Mac's fixed https address through the host opener", () => {
  const src = at("sources/SourcePanes.tsx");
  assert.match(src, /export const BOX_CONSOLE_URL = "https:\/\/app\.box\.com\/developers\/console";/);
  const pane = block(src, "export function BoxPane(");
  assert.match(pane, /env\.openExternal\(BOX_CONSOLE_URL\)\.catch\(/);
  assert.match(pane, /Open Box Developer Console/);
});

test("reveal meetings folder: llm-doc prefix (project-root relative), meetings first, then its parent", () => {
  assert.deepEqual([...MEETINGS_REVEAL_PATHS], ["llm-doc/source/meetings", "llm-doc/source"]);
  const screen = at("LibraryScreen.tsx");
  const reveal = block(screen, "const revealMeetings = useCallback(");
  assert.match(reveal, /revealFirst\(MEETINGS_REVEAL_PATHS, onRevealPath\)/);
  assert.match(reveal, /setLinkNotice\("The meetings folder could not be revealed/);
  assert.match(screen, /onRevealMeetings=\{onRevealPath \? \(\) => void revealMeetings\(\) : undefined\}/);
  const nav = at("LibraryNav.tsx");
  assert.match(nav, /onRevealMeetings\?: \(\) => void;/);
  assert.match(nav, /Reveal meetings folder/);
});

test("revealFirst: stops at the first folder the host reveals, falls back when it is missing, false when all fail", async () => {
  const seen: string[] = [];
  const missing = new Set(["llm-doc/source/meetings"]);
  const reveal = async (p: string) => { seen.push(p); if (missing.has(p)) throw new Error("not_found"); };
  assert.equal(await revealFirst(MEETINGS_REVEAL_PATHS, reveal), true);
  assert.deepEqual(seen, ["llm-doc/source/meetings", "llm-doc/source"]);
  seen.length = 0; missing.clear();
  assert.equal(await revealFirst(MEETINGS_REVEAL_PATHS, reveal), true);
  assert.deepEqual(seen, ["llm-doc/source/meetings"], "the parent is not opened when the meetings folder exists");
  missing.add("llm-doc/source/meetings"); missing.add("llm-doc/source");
  assert.equal(await revealFirst(MEETINGS_REVEAL_PATHS, reveal), false);
});

test("note open Retry: a failed read shows Retry, which bumps the load's retry key", () => {
  const viewer = at("NoteViewer.tsx");
  assert.match(viewer, /export function useNoteLoad\(host: NotesHost, rel: string, reloadKey: number \| undefined, retry = 0\): Load \{/);
  assert.match(viewer, /\[host, rel, reloadKey, retry\],/, "the retry counter is a load dependency");
  assert.match(viewer, /const \[retry, setRetry\] = useState\(0\);/);
  assert.match(viewer, /useNoteLoad\(host, rel, reloadKey, retry\)/);
  assert.match(viewer, /\{load\.phase === "error" && \(\s*<button type="button" className="lib-btn" onClick=\{\(\) => setRetry\(\(n\) => n \+ 1\)\}>\s*Retry\s*<\/button>/);
});

test("Slack: Select All / Select None edit only the pending selection, within the 100-channel cap", () => {
  const pane = block(at("sources/SourcePanes.tsx"), "export function SlackPane(");
  const all = inner(pane, "const selectAll = ");
  assert.match(all, /selectAllChannels\(cfg\.channels, available \?\? \[\]\)/);
  assert.match(all, /r\.left > 0 \? `At most \$\{SLACK_MAX_CHANNELS\} channels can be chosen/, "the cap is never silent");
  assert.match(all, /setSaved\(false\);/);
  assert.ok(!/update\(/.test(all), "Select All never saves");
  const none = inner(pane, "const selectNone = ");
  assert.match(none, /channels: \[\]/);
  assert.ok(!/update\(/.test(none), "Select None never saves");
  assert.match(pane, /Select All\s*<\/button>/);
  assert.match(pane, /Select None\s*<\/button>/);
  assert.match(pane, /disabled=\{!available \|\| available\.length === 0\}/);
  assert.match(pane, /disabled=\{cfg\.channels\.length === 0\}/);
  // Chosen channels missing from the loaded list stay visible and removable (Mac orphanedIds).
  assert.match(pane, /const orphans = cfg\.channels\.filter\(\(c\) => !loadedIds\.has\(c\.id\)\);/);
  assert.match(pane, /\{orphans\.length > 0 && \(\s*<ul className="lib-items" aria-label="Chosen channels not in the current list"/);
  assert.match(pane, /\{orphans\.map\(\(c\) => \(/);
  assert.match(pane, /Previously selected, not in the current channel list \(may need a broader Slack permission\)\./);
  assert.match(pane, /<input type="checkbox" checked onChange=\{\(\) => toggle\(c\)\} \/>/);
});

test("saved group 'month' (legacy, no control to change it) shows the date buckets; other saved values are kept", () => {
  assert.equal(groupFromPrefs("month"), "relative");
  assert.equal(groupFromPrefs(undefined), "relative");
  assert.equal(groupFromPrefs("relative"), "relative");
  assert.equal(groupFromPrefs("folder"), "folder");
  assert.equal(groupFromPrefs("none"), "none");
});

test("LibraryStore loads the legacy saved group 'month' as the date buckets, and keeps 'folder'", () => {
  const g = globalThis as { localStorage?: unknown };
  const desc = Object.getOwnPropertyDescriptor(g, "localStorage");
  const build = (group: string, filters?: object) => snap(group, filters).group;
  const snap = (group: string, filters?: object) => {
    const store = {
      getItem: (k: string) => (k === "llmide.library.prefs" ? JSON.stringify({ group, filters }) : null),
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    };
    Object.defineProperty(g, "localStorage", { value: store, configurable: true, writable: true });
    try {
      return new LibraryStore({ host: new FakeHost() }).getSnapshot();
    } finally {
      if (desc) Object.defineProperty(g, "localStorage", desc);
      else delete g.localStorage;
    }
  };
  assert.equal(build("month"), "relative");
  assert.equal(build("folder"), "folder");
  assert.deepEqual(snap("relative", { query: "q", platform: "zoom", hasSummary: true, range: "7d" }).filters, { ...NO_FILTERS, query: "q" });
});

const ch = (i: number) => ({ id: `C${String(i).padStart(9, "0")}`, name: `c${i}` });

test("selectAllChannels: kept channels first, no duplicates, capped at 100 with the overflow counted", () => {
  const kept = [ch(1), { id: "C999999999", name: "gone" }];
  const r = selectAllChannels(kept, [ch(1), ch(2), ch(3)]);
  assert.deepEqual(r.channels.map((c) => c.id), [ch(1).id, "C999999999", ch(2).id, ch(3).id]);
  assert.equal(r.left, 0);
  const many = Array.from({ length: 150 }, (_, i) => ch(i + 10));
  const big = selectAllChannels([], many);
  assert.equal(big.channels.length, SLACK_MAX_CHANNELS);
  assert.equal(big.left, 50, "150 loaded channels: 50 did not fit, and the pane says so");
  assert.equal(validateSlack({ channels: big.channels, lookbackDays: 7 }).channels, undefined, "the capped choice is still savable");
  assert.equal(selectAllChannels(kept, []).channels.length, 2, "Select All with nothing loaded keeps the pending choice");
});

test("saved platform / summary / date-range filters (old builds had controls, the Mac has none) do not hide notes", () => {
  assert.deepEqual(filtersFromPrefs({ query: "acme", platform: "zoom", hasSummary: true, range: "7d" }), { ...NO_FILTERS, query: "acme" });
  assert.deepEqual(filtersFromPrefs(undefined), NO_FILTERS);
  assert.deepEqual(filtersFromPrefs({ query: 5 as unknown as string }), NO_FILTERS);
});
