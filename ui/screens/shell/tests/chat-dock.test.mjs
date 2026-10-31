import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SHELL, load, React, renderToStaticMarkup } from "./helpers.mjs";

const h = React.createElement;
const html = (el) => renderToStaticMarkup(el);
const REPO = resolve(SHELL, "../../..");
const seam = await load("chat-dock.tsx");

test("chat dock seam: nothing installed shows a visible note; installing swaps in a lazy dock with a loading state", () => {
  seam.resetChatDock();
  assert.equal(seam.isChatDockInstalled(), false);
  const none = html(h(seam.ChatDockSlot, { active: true, projectRoot: "/p" }));
  assert.match(none, /role="status"/);
  assert.match(none, /The Code Assistant is not available in this build/);
  seam.installChatDock(() => new Promise(() => {}));
  assert.equal(seam.isChatDockInstalled(), true);
  const loading = html(h(seam.ChatDockSlot, { active: true, projectRoot: "/p" }));
  assert.match(loading, /Loading Code Assistant/);
  assert.match(loading, /aria-busy="true"/);
  seam.resetChatDock();
});

test("wiring: the shell installs the Chat dock, and both chat surfaces use the one shared runtime", () => {
  const screens = readFileSync(join(SHELL, "screens.tsx"), "utf8");
  assert.match(screens, /installChatDock\(dockLoader\)/);
  assert.match(screens, /\.\.\/chat\/dock\.tsx/);
  const chat = join(REPO, "ui/screens/chat");
  const dock = readFileSync(join(chat, "dock.tsx"), "utf8");
  const section = readFileSync(join(chat, "index.tsx"), "utf8");
  for (const [name, src] of [["dock", dock], ["section", section]]) {
    assert.match(src, /useChatSurface\(projectRoot, active\)/, `${name} uses the shared surface`);
    assert.match(src, /shared=\{rt\.ui\}/, `${name} shares the UI state`);
    assert.match(src, /controller=\{rt\.controller\} store=\{rt\.store\}/, `${name} shares controller and store`);
    assert.doesNotMatch(src, /new ChatController|new TauriChatStore|new HttpChatStore/, `${name} must not build its own chat engine`);
  }
  const surface = readFileSync(join(chat, "surface.tsx"), "utf8");
  assert.equal((surface.match(/new ChatController\(/g) ?? []).length, 1, "one controller in the whole app");
});
