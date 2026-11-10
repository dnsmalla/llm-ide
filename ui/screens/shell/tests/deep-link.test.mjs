import { test } from "node:test";
import assert from "node:assert/strict";
import { deepLinkSection } from "../deep-link.ts";

test("llmide:// tabs map to desktop sections", () => {
  assert.equal(deepLinkSection("llmide://transcript?session=abc"), "live");
  assert.equal(deepLinkSection("llmide://plan"), "gantt");
  assert.equal(deepLinkSection("llmide://review"), "conflicts");
  assert.equal(deepLinkSection("llmide://history"), "chat");
  assert.equal(deepLinkSection("llmide://settings"), "settings");
});

test("untrusted or unknown deep links are refused", () => {
  for (const u of ["https://transcript", "llmide://elsewhere", "llmide://transcript/path", "llmide://user:pw@transcript", "not a url"]) {
    assert.equal(deepLinkSection(u), null, u);
  }
});
