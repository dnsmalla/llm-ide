import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ATTACH_LIMITS, cleanName, readTextAttachment } from "../src/chat/attachments.ts";
import * as core from "../../ui/screens/chat/attach/limits.ts";

const vector = JSON.parse(readFileSync(new URL("../../schema/host-api/v1/fixtures/security/compose.json", import.meta.url), "utf8"));
const file = (text, name = "notes.md", type = "text/markdown") => new File([text], name, { type });
test("limits are the shared vector's and the core's", () => {
  assert.equal(ATTACH_LIMITS.maxFiles, vector.attachments.maxFiles);
  assert.equal(ATTACH_LIMITS.maxNameChars, vector.attachments.maxNameChars);
  assert.equal(ATTACH_LIMITS.maxCharsPerFile, vector.attachments.maxCharsPerFile);
  assert.equal(ATTACH_LIMITS.maxCharsTotal, vector.attachments.maxCharsTotal);
  assert.equal(ATTACH_LIMITS.maxCharsPerFile, core.MAX_TEXT_CHARS_PER_FILE);
  assert.equal(ATTACH_LIMITS.maxCharsTotal, core.MAX_TEXT_CHARS_TOTAL);
  assert.equal(ATTACH_LIMITS.maxFileBytes, core.HOST_FILE_MAX_BYTES);
});
test("a text file becomes {name, text}; the name is a bare file name", async () => {
  const r = await readTextAttachment(file("hello"), 0);
  assert.deepEqual(r, { ok: true, attachment: { name: "notes.md", text: "hello", truncated: false } });
  assert.equal(cleanName("C:\\Users\\me\\secret\\plan.txt"), "plan.txt");
  assert.equal(cleanName("/home/me/.ssh/id_rsa"), "id_rsa");
  assert.equal(cleanName("a\u0000b\nc.md"), "abc.md");
  assert.equal(cleanName(""), "file.txt");
  assert.equal(cleanName("x".repeat(400)).length, 300);
});
test("a long file is cut to the per-file cap and to what is left of the total", async () => {
  const big = await readTextAttachment(file("a".repeat(90_000)), 0);
  assert.equal(big.attachment.text.length, 80_000); assert.equal(big.attachment.truncated, true);
  const rest = await readTextAttachment(file("b".repeat(50_000)), 180_000);
  assert.equal(rest.attachment.text.length, 20_000); assert.equal(rest.attachment.truncated, true);
  const full = await readTextAttachment(file("c"), 200_000); assert.equal(full.ok, false); assert.match(full.reason, /200,000/);
});
test("images, binaries and non-text types are refused with a reason", async () => {
  assert.equal(vector.attachments.imagesAllowed, false);
  const img = await readTextAttachment(file("x", "a.png", "image/png"), 0); assert.equal(img.ok, false); assert.match(img.reason, /images/i);
  const pdf = await readTextAttachment(file("x", "a.pdf", "application/pdf"), 0); assert.equal(pdf.ok, false);
  const bin = await readTextAttachment(file("ab\u0000cd", "a.dat", ""), 0); assert.equal(bin.ok, false); assert.match(bin.reason, /binary/);
  const json = await readTextAttachment(file("{}", "a.json", "application/json"), 0); assert.equal(json.ok, true);
});
test("a file over 25 MB is refused without reading it", async () => {
  let read = false;
  const huge = { name: "big.log", type: "text/plain", size: ATTACH_LIMITS.maxFileBytes + 1, slice: () => ({ text: async () => { read = true; return ""; } }) };
  const r = await readTextAttachment(huge, 0); assert.equal(r.ok, false); assert.equal(read, false);
});
