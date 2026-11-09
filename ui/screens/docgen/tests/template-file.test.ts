// Template file import: the picker's handle is read in bounded chunks, released on every path, and only .md/.txt
// UTF-8 text under the size cap is accepted. The fake host records every call so release is checked, not assumed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickTemplateFile, settlePick, TEMPLATE_FILE_MAX_BYTES } from "../template-file.ts";

type Call = { cmd: string; args?: Record<string, unknown> };

function host(files: Array<{ handle: string; name: string; size: number; mime: string }>, bytes: Uint8Array, opts: { rejected?: Array<{ name: string; reason: string }>; readFails?: boolean } = {}) {
  const calls: Call[] = [];
  const invoke = (async (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (cmd === "attach_pick_files") return { files, rejected: opts.rejected ?? [] };
    if (cmd === "attach_read") {
      if (opts.readFails) throw new Error("io");
      const { offset, len } = args as { offset: number; len: number };
      return bytes.slice(offset, offset + len);
    }
    if (cmd === "attach_release") return undefined;
    throw new Error(`unexpected ${cmd}`);
  }) as Parameters<typeof pickTemplateFile>[0];
  return { invoke, calls, releases: () => calls.filter((c) => c.cmd === "attach_release").map((c) => (c.args as { handle: string }).handle) };
}

const enc = (s: string) => new TextEncoder().encode(s);

test("a picked .md file is read and returned as text, and its handle is released", async () => {
  const body = "# Weekly review\n\n## Wins\n\n## Risks\n";
  const h = host([{ handle: "h1", name: "weekly.md", size: enc(body).length, mime: "text/markdown" }], enc(body));
  const r = await pickTemplateFile(h.invoke);
  assert.deepEqual(r, { kind: "ok", name: "weekly.md", text: body });
  assert.deepEqual(h.releases(), ["h1"]);
});

test("cancelling the picker is not an error", async () => {
  const h = host([], enc(""));
  assert.deepEqual(await pickTemplateFile(h.invoke), { kind: "cancelled" });
  assert.equal(h.calls.some((c) => c.cmd === "attach_read"), false);
});

test("other extensions are refused before any byte is read, and the handle is still released", async () => {
  const h = host([{ handle: "h2", name: "photo.png", size: 4, mime: "image/png" }], enc("abcd"));
  const r = await pickTemplateFile(h.invoke);
  assert.equal(r.kind, "error");
  assert.match((r as { message: string }).message, /\.md or \.txt/);
  assert.equal(h.calls.some((c) => c.cmd === "attach_read"), false);
  assert.deepEqual(h.releases(), ["h2"]);
});

test("a file over the cap is refused from its pick-time size, before reading", async () => {
  const h = host([{ handle: "h3", name: "big.md", size: TEMPLATE_FILE_MAX_BYTES + 1, mime: "text/markdown" }], enc(""));
  const r = await pickTemplateFile(h.invoke);
  assert.equal(r.kind, "error");
  assert.match((r as { message: string }).message, /256 KB/);
  assert.equal(h.calls.some((c) => c.cmd === "attach_read"), false);
  assert.deepEqual(h.releases(), ["h3"]);
});

test("invalid UTF-8 and NUL bytes are refused, not decoded into replacement characters", async () => {
  const bad = new Uint8Array([0x23, 0x20, 0x41, 0xff, 0xfe]);
  const bad8 = await pickTemplateFile(host([{ handle: "a", name: "t.md", size: bad.length, mime: "text/markdown" }], bad).invoke);
  assert.equal(bad8.kind, "error");
  assert.match((bad8 as { message: string }).message, /UTF-8/);
  const nul = new Uint8Array([0x23, 0x20, 0x00, 0x41]);
  const nulR = await pickTemplateFile(host([{ handle: "b", name: "t.txt", size: nul.length, mime: "text/plain" }], nul).invoke);
  assert.equal(nulR.kind, "error");
  assert.match((nulR as { message: string }).message, /not Markdown text/);
});

test("a read failure still releases the handle and reports nothing as text", async () => {
  const h = host([{ handle: "h4", name: "t.md", size: 5, mime: "text/markdown" }], enc("hello"), { readFails: true });
  await assert.rejects(() => pickTemplateFile(h.invoke));
  assert.deepEqual(h.releases(), ["h4"]);
});

test("extra picked files are released at once; only the first is read", async () => {
  const body = "## One";
  const h = host([
    { handle: "first", name: "a.md", size: body.length, mime: "text/markdown" },
    { handle: "second", name: "b.md", size: 3, mime: "text/markdown" },
  ], enc(body));
  const r = await pickTemplateFile(h.invoke);
  assert.equal(r.kind, "ok");
  assert.deepEqual(h.releases().sort(), ["first", "second"]);
  assert.ok(h.calls.filter((c) => c.cmd === "attach_read").every((c) => (c.args as { handle: string }).handle === "first"));
});

test("a rejected pick reports a plain message with no host reason code", async () => {
  const h = host([], enc(""), { rejected: [{ name: "x.md", reason: "too_large" }] });
  const r = await pickTemplateFile(h.invoke);
  assert.deepEqual(r, { kind: "error", message: "That file could not be opened." });
});

test("M7: a picker that throws becomes an error result, not an unhandled rejection", async () => {
  const out = await settlePick(async () => { throw new Error("attach_pick_files: host unavailable"); });
  assert.equal(out.kind, "error");
  assert.match(out.kind === "error" ? out.message : "", /could not be opened/);
  assert.deepEqual(await settlePick(async () => ({ kind: "cancelled" })), { kind: "cancelled" });
});

