import { test } from "node:test";
import assert from "node:assert/strict";
import { TRAY_TEXT, decodeTrayStatus } from "../misc-model.ts";

test("tray status: all three flags required, booleans only", () => {
  assert.deepEqual(decodeTrayStatus({ available: true, closeToTray: false, iconVisible: true }), { available: true, closeToTray: false, iconVisible: true });
  assert.deepEqual(decodeTrayStatus({ available: true, closeToTray: true, iconVisible: false }), { available: true, closeToTray: true, iconVisible: false });
  for (const bad of [
    null,
    {},
    { available: true, closeToTray: false },
    { available: "yes", closeToTray: false, iconVisible: true },
    { available: true, closeToTray: 0, iconVisible: true },
    { available: true, closeToTray: false, iconVisible: null },
  ]) {
    assert.equal(decodeTrayStatus(bad), null, JSON.stringify(bad));
  }
});

test("the menu-bar hint names the close-to-tray consequence", () => {
  assert.match(TRAY_TEXT.hint, /close to tray/);
  assert.equal(TRAY_TEXT.label, "Menu-bar icon");
});
