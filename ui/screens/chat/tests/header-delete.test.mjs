// The header trash deletes the open chat, asking first only when it has messages (the Mac's clearChatButton).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadChat, h, renderToStaticMarkup as html, CHAT } from "./helpers.mjs";

let c;
before(async () => { c = await loadChat("header-delete"); });
const noop = () => {};
const props = { sessions: [{ id: "s1", title: "One", updatedAt: 1 }], activeId: "s1", busyIds: new Set(), route: null, routeDisabled: false, onSelect: noop, onNew: noop, onSetLimit: async () => {} };

test("an empty chat is deleted at once; a chat with messages asks first", () => {
  assert.equal(c.deleteChatAction(false), "delete");
  assert.equal(c.deleteChatAction(true), "confirm");
});

test("the trash is a named control only when a chat is open and can be deleted, before New chat", () => {
  const out = html(h(c.DockHeader, { ...props, onDelete: noop, hasMessages: true }));
  assert.ok(out.indexOf('aria-label="Delete current chat"') >= 0);
  assert.ok(out.indexOf('aria-label="Delete current chat"') < out.indexOf('aria-label="New chat"'));
  assert.doesNotMatch(html(h(c.DockHeader, props)), /Delete current chat/, "no onDelete, no trash");
  assert.doesNotMatch(html(h(c.DockHeader, { ...props, activeId: null, onDelete: noop })), /Delete current chat/);
});

test("the screen tells the header whether the open chat has messages", () => {
  assert.match(readFileSync(join(CHAT, "ChatScreen.tsx"), "utf8"), /hasMessages=\{state\.messages\.length > 0\}/);
});

test("a chat whose turn is running cannot be deleted: the turn would run on with no Stop left", () => {
  assert.equal(c.deleteBlockedWhileRunning("s1", new Set(["s1"])), true);
  assert.equal(c.deleteBlockedWhileRunning("s1", new Set(["other"])), false);
  assert.equal(c.deleteBlockedWhileRunning(null, new Set(["s1"])), false);
  const running = html(h(c.DockHeader, { ...props, busyIds: new Set(["s1"]), onDelete: noop, hasMessages: true }));
  assert.match(running, /aria-label="Delete current chat"[^>]*disabled=""/);
  assert.match(running, new RegExp(c.DELETE_WHILE_RUNNING_TITLE));
  const idle = html(h(c.DockHeader, { ...props, onDelete: noop, hasMessages: true }));
  assert.doesNotMatch(idle, /aria-label="Delete current chat"[^>]*disabled/);
  assert.match(readFileSync(join(CHAT, "ChatScreen.tsx"), "utf8"), /if \(controller\.busyIds\(\)\.includes\(id\)\) return;/);
});
