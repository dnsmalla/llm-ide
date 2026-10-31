import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadChat, h, renderToStaticMarkup as html } from "./helpers.mjs";

let c;
before(async () => { c = await loadChat("attach"); });

const PNG = (n) => { const b = new Uint8Array(n); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); for (let i = 8; i < n; i++) b[i] = i & 255; return b; };
const utf8 = (s) => new TextEncoder().encode(s);

/** A fake host: files by handle, a read log, a release log, optional per-read hook (to cancel mid-read). */
function fakeHost(files, { rejected = [], onRead } = {}) {
  const live = new Map();
  const log = { reads: [], released: [], picks: 0 };
  const host = {
    async pick() {
      log.picks++;
      return { files: files.map((f, i) => { const handle = `h${log.picks}-${i}`; live.set(handle, f.bytes); return { handle, name: f.name, size: f.size ?? f.bytes.length, mime: f.mime ?? "text/plain" }; }), rejected };
    },
    async read(handle, offset, len) {
      assert.ok(len <= c.HOST_CHUNK_BYTES, `read of ${len} exceeds the host's 4 MiB cap`);
      log.reads.push([handle, offset, len]);
      const bytes = live.get(handle);
      assert.ok(bytes, `read of a released/unknown handle ${handle}`);
      await onRead?.(handle, offset);
      return bytes.slice(offset, offset + len);
    },
    release(handle) { log.released.push(handle); live.delete(handle); },
  };
  return { host, log, live };
}
const blobs = () => { const made = [], revoked = []; return { made, revoked, create: (b, m) => { made.push(m); return `blob:${made.length}`; }, revoke: (u) => revoked.push(u) }; };
const mgr = (host, extra = {}) => new c.AttachmentManager({ host, project: null, blobs: null, ...extra });

test("codec: image sniffing, UTF-8 head decoding, base64", () => {
  assert.equal(c.sniffImage(PNG(20)), "image/png");
  assert.equal(c.sniffImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0])), "image/jpeg");
  assert.equal(c.sniffImage(utf8("GIF89a....")), "image/gif");
  assert.equal(c.sniffImage(utf8("RIFF\0\0\0\0WEBPVP8 ")), "image/webp");
  assert.equal(c.sniffImage(utf8("hello world")), null);
  assert.equal(c.decodeText(utf8("héllo"), false).text, "héllo");
  assert.equal(c.decodeText(Uint8Array.from([0x68, 0, 0x69]), false).reason, "binary");
  assert.equal(c.decodeText(Uint8Array.from([0xff, 0xfe, 0x41]), false).reason, "not_utf8");
  const euro = utf8("a€"); // 3-byte char
  const cutHead = euro.slice(0, 3); // cuts the euro sign
  assert.equal(c.decodeText(cutHead, false).ok, false);
  const ok = c.decodeText(cutHead, true);
  assert.equal(ok.text, "a");
  assert.equal(c.decodeText(Uint8Array.from([0xef, 0xbb, 0xbf, 0x68, 0x69]), false).text, "hi");
  assert.equal(c.toBase64(utf8("hello")), "aGVsbG8=");
  const big = PNG(4_000_000);
  assert.equal(c.toBase64(big).length, Math.ceil(4_000_000 / 3) * 4); // no stack overflow
  assert.equal(c.safeFileName("/Users/me/secret/dir/report\u202E.txt"), "report.txt");
  assert.equal(c.safeFileName(""), "file");
});

test("pick: a text file is read, labelled by its name (never a path), handle released at once", async () => {
  const { host, log } = fakeHost([{ name: "/Users/me/notes.md", bytes: utf8("# Notes\nhello"), mime: "text/markdown" }]);
  const m = mgr(host);
  await m.pickFiles();
  const [it] = m.getItems();
  assert.equal(it.label, "notes.md");
  assert.equal(it.status, "ready");
  assert.equal(it.kind, "text");
  assert.ok(!JSON.stringify(m.getItems()).includes("/Users"));
  assert.deepEqual(log.released, ["h1-0"], "the host handle is released as soon as the read is done");
  const wire = m.consume();
  assert.deepEqual(wire, [{ path: "notes.md", content: "# Notes\nhello" }]);
  assert.equal(m.getItems().length, 0, "consumed attachments are cleared");
});

test("image: chunked read across 4 MiB reads with progress, wire format, blob preview revoked after send", async () => {
  const size = 4 * 1024 * 1024 + 123_456 > c.MAX_IMAGE_BYTES ? c.MAX_IMAGE_BYTES - 10 : 4 * 1024 * 1024 + 123_456;
  const progress = [];
  const { host, log } = fakeHost([{ name: "shot.png", bytes: PNG(size), mime: "image/png" }]);
  const b = blobs();
  const m = mgr(host, { blobs: b });
  m.subscribe(() => { const it = m.getItems()[0]; if (it) progress.push(it.progress); });
  await m.pickFiles();
  const [it] = m.getItems();
  assert.equal(it.status, "ready");
  assert.equal(it.kind, "image");
  assert.equal(it.previewUrl, "blob:1");
  assert.ok(log.reads.length >= 2 && log.reads.every(([, , len]) => len <= c.HOST_CHUNK_BYTES));
  assert.ok(progress.some((p) => p > 0 && p < 1), "progress is reported between chunks");
  assert.deepEqual(log.released, ["h1-0"]);
  const [w] = m.consume();
  assert.match(w.content, /^\[binary:image\/png\]\n[A-Za-z0-9+/=]+$/);
  assert.equal(w.content.length, "[binary:image/png]\n".length + Math.ceil(size / 3) * 4);
  assert.deepEqual(b.revoked, ["blob:1"], "blob URLs are revoked when the attachment leaves the composer");
});

test("cancel mid-read: no content, handle released, later chunks never read, blob never made", async () => {
  let mgr1;
  const size = 4_400_000;
  const { host, log } = fakeHost([{ name: "big.png", bytes: PNG(size), mime: "image/png" }], { onRead: (_h, off) => { if (off > 0) mgr1.remove(mgr1.getItems()[0].id); } });
  const b = blobs();
  mgr1 = mgr(host, { blobs: b });
  await mgr1.pickFiles();
  assert.equal(mgr1.getItems().length, 0);
  assert.deepEqual(log.released, ["h1-0"]);
  assert.equal(log.reads.length, 2, "reading stops after the cancel");
  assert.equal(b.made.length, 0);
});

test("limits: text cut at 80,000 characters, never reads more than 320 KB of a huge file, cut flagged", async () => {
  const text = "line of text\n".repeat(30_000); // 390 KB
  const { host, log } = fakeHost([{ name: "log.txt", bytes: utf8(text), size: 24 * 1024 * 1024 }]);
  const m = mgr(host);
  await m.pickFiles();
  const [it] = m.getItems();
  assert.equal(it.status, "ready");
  assert.equal(it.truncated, true);
  assert.ok(it.chars <= c.MAX_TEXT_CHARS_PER_FILE);
  assert.equal(log.reads.length, 1);
  assert.ok(log.reads[0][2] <= c.TEXT_READ_BYTES, "only the head of a big file is read");
});

test("limits: binary, oversized, non-image 'image', empty files and total budget are refused with reasons", async () => {
  const { host } = fakeHost([
    { name: "a.bin", bytes: Uint8Array.from([1, 2, 0, 3, 4]), mime: "application/octet-stream" },
    { name: "huge.txt", bytes: utf8("x"), size: 26 * 1024 * 1024 },
    { name: "fake.png", bytes: utf8("not really a png"), mime: "image/png" },
    { name: "empty.txt", bytes: new Uint8Array(0), size: 0 },
    { name: "huge.png", bytes: PNG(100), size: 6 * 1024 * 1024, mime: "image/png" },
    { name: "ok.txt", bytes: utf8("fine") },
  ], { rejected: [{ name: "/etc/passwd-dir", reason: "not_regular" }, { name: "x.iso", reason: "too_large" }] });
  const m = mgr(host);
  await m.pickFiles();
  const by = Object.fromEntries(m.getItems().map((i) => [i.label, i]));
  assert.match(by["a.bin"].error, /Binary files/);
  assert.match(by["huge.txt"].error, /larger than 25 MB/);
  assert.match(by["fake.png"].error, /Not a supported image/);
  assert.match(by["empty.txt"].error, /empty/);
  assert.equal(by["ok.txt"].status, "ready");
  const n = [...m.getNotices()];
  assert.ok(n.some((x) => /passwd-dir is not a regular file/.test(x)) && n.some((x) => /x\.iso is larger than 25 MB/.test(x)));
  assert.equal(m.consume().length, 1, "only the good file is sent");
});

test("limits: 30 files per message, 8 images, 200,000 characters in total", async () => {
  const many = Array.from({ length: 34 }, (_, i) => ({ name: `f${i}.txt`, bytes: utf8(`text ${i}`) }));
  const { host } = fakeHost(many);
  const m = mgr(host);
  await m.pickFiles();
  assert.equal(m.getItems().length, c.MAX_ATTACHMENTS);
  assert.match(m.getNotices().join(" "), /At most 30 attachments/);

  const imgs = Array.from({ length: 10 }, (_, i) => ({ name: `i${i}.png`, bytes: PNG(64), mime: "image/png" }));
  const m2 = mgr(fakeHost(imgs).host);
  await m2.pickFiles();
  assert.equal(m2.getItems().filter((i) => i.status === "ready").length, c.MAX_IMAGES);
  assert.ok(m2.getItems().filter((i) => i.status === "error").every((i) => /At most 8 images/.test(i.error)));

  const big = utf8("y".repeat(c.MAX_TEXT_CHARS_PER_FILE));
  const m3 = mgr(fakeHost([1, 2, 3, 4].map((i) => ({ name: `b${i}.txt`, bytes: big }))).host);
  await m3.pickFiles();
  const ready = m3.getItems().filter((i) => i.status === "ready");
  assert.equal(ready.reduce((n, i) => n + i.chars, 0), c.MAX_TEXT_CHARS_TOTAL);
  assert.ok(m3.getItems().some((i) => i.status === "error" && /budget/.test(i.error)));
});

test("duplicate names get unique labels; notes and project files attach as text", async () => {
  const { host } = fakeHost([{ name: "a.txt", bytes: utf8("1") }, { name: "a.txt", bytes: utf8("2") }]);
  const project = { async readHead(path) { return path === "bin.dat" ? { text: "", truncated: false, binary: true } : { text: `contents of ${path}`, truncated: path.endsWith("big.ts"), binary: false }; } };
  const m = mgr(host, { project });
  await m.pickFiles();
  await m.addProjectFile("src/app.ts");
  await m.addProjectFile("src/big.ts");
  await m.addProjectFile("bin.dat");
  m.addNote("Design review", "Design review\nsnippet text");
  const labels = m.getItems().map((i) => i.label);
  assert.deepEqual(labels, ["a.txt", "a (2).txt".replace("a (2)", "a.txt".slice(0, 1) + " (2)"), "src/app.ts", "src/big.ts", "bin.dat", "note: Design review"]);
  const wire = m.consume();
  assert.deepEqual(wire.map((w) => w.path), ["a.txt", "a (2).txt", "src/app.ts", "src/big.ts", "note: Design review"]);
});

test("busy while reading; clear and dispose cancel reads and release every handle", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { host, log } = fakeHost([{ name: "a.txt", bytes: utf8("hello") }, { name: "b.txt", bytes: utf8("world") }], { onRead: () => gate });
  const m = mgr(host);
  const p = m.pickFiles();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(m.isBusy(), true);
  assert.equal(m.getItems().length, 2);
  m.dispose(); // unmount: cancel reads
  release();
  await p;
  assert.equal(m.getItems().length, 0);
  assert.equal(m.isBusy(), false);
  assert.deepEqual([...log.released].sort(), ["h1-0", "h1-1"]);
});

test("host failures are reported without paths; no host = no pick", async () => {
  const failing = { async pick() { throw new Error("denied /Users/me"); }, async read() { return new Uint8Array(); }, release() {} };
  const m = mgr(failing);
  await m.pickFiles();
  assert.match(m.getNotices()[0], /file dialog could not be opened/);
  assert.ok(!m.getNotices().join(" ").includes("/Users"));
  const none = mgr(null);
  assert.equal(none.canPick, false);
  await none.pickFiles();
  assert.equal(none.getItems().length, 0);
  const readFails = { async pick() { return { files: [{ handle: "x", name: "a.txt", size: 3, mime: "text/plain" }], rejected: [] }; }, async read() { throw new Error("io"); }, release() { released.push("x"); } };
  const released = [];
  const m2 = mgr(readFails);
  await m2.pickFiles();
  assert.equal(m2.getItems()[0].status, "error");
  assert.deepEqual(released, ["x"]);
});

test("createHostAttach: shapes the Rust commands' answers, validates, never passes a path", async () => {
  const calls = [];
  const invoke = async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === "attach_pick_files") return { files: [{ handle: "t", name: "a.txt", size: 2, mime: "text/plain" }, { bad: true }], rejected: [{ name: "x", reason: "too_large" }, 5] };
    if (cmd === "attach_read") return new Uint8Array([104, 105]).buffer;
    return undefined;
  };
  const host = c.createHostAttach(invoke);
  const r = await host.pick();
  assert.deepEqual(r, { files: [{ handle: "t", name: "a.txt", size: 2, mime: "text/plain" }], rejected: [{ name: "x", reason: "too_large" }] });
  assert.deepEqual([...await host.read("t", 0, 2)], [104, 105]);
  await host.release("t");
  assert.deepEqual(calls.map((x) => x[0]), ["attach_pick_files", "attach_read", "attach_release"]);
  assert.deepEqual(calls[1][1], { handle: "t", offset: 0, len: 2 });
});

test("ComposerChips: roles, progress, errors, remove buttons named", async () => {
  const { host } = fakeHost([{ name: "a.txt", bytes: utf8("hello") }, { name: "x.bin", bytes: Uint8Array.from([0, 1]) }]);
  const m = mgr(host);
  await m.pickFiles();
  const out = html(h(c.ComposerChips, { skills: [{ id: "s", name: "design", kind: "library" }], attachments: [...m.getItems(), { id: "r", label: "big.png", source: "file", kind: "image", status: "reading", progress: 0.4, size: 9, truncated: false, error: null, previewUrl: "blob:abc", chars: 0 }], notices: ["x.iso is larger than 25 MB."], message: null, onRemoveSkill() {}, onRemoveAttachment() {}, onDismissNotices() {} }));
  assert.match(out, /aria-label="Skills for this message"/);
  assert.match(out, /aria-label="Attachments"/);
  assert.match(out, /aria-label="Remove skill design"/);
  assert.match(out, /aria-label="Remove attachment a\.txt"/);
  assert.match(out, /aria-label="Cancel reading big\.png"/);
  assert.match(out, /<progress[^>]*aria-label="Reading big\.png"/);
  assert.match(out, /role="alert"[^>]*>Binary files/);
  assert.match(out, /<img[^>]*src="blob:abc"[^>]*alt=""/);
  assert.match(out, /role="status"/);
  assert.equal(html(h(c.ComposerChips, { skills: [], attachments: [], notices: [], message: null, onRemoveSkill() {}, onRemoveAttachment() {}, onDismissNotices() {} })), "");
});
