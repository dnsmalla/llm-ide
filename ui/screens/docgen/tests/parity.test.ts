// Doc Gen / Visual parity with the Mac app: the Setup folder the UI shows is the folder the run saves into, "Save
// chat output" writes its own file once per reply, and a refused revision reports whether it applied.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DocGenStore } from "../store.ts";
import { GenerationRun } from "../run.ts";
import { fileItem } from "../sources.ts";
import { GENERATED_DIR, normalizeDestination } from "../naming.ts";
import type { DocTemplate } from "../model.ts";
import { controllableApi, FsErr, MemFs, okResult, readersFrom, tick } from "./fakes.ts";

const tpl: DocTemplate = { id: "t", name: "Retro", sections: ["A"], rawContent: "", isBuiltin: false, folderName: "retro", isProjectTemplate: true, surface: "doc" };

function makeStore(destination?: string) {
  const fs = new MemFs();
  const api = {
    async register() { return { id: 'p1' }; },
    async templates() { return { items: [tpl], truncated: false }; },
    async commands() { return { items: [], truncated: false }; },
    async seed() { return { written: 0 }; },
    async generate() { return okResult("doc"); },
  };
  const store = new DocGenStore({
    surface: "doc",
    makeApi: () => api as never,
    run: { readers: readersFrom({ "a.md": "alpha" }), fs, destination },
    idFor: async (root) => `id${root.length}`,
  });
  return { store, fs };
}

test("the Setup folder is normalized the same way for the UI and the run", () => {
  assert.equal(normalizeDestination("/a\\b/"), "a/b");
  assert.equal(normalizeDestination(""), GENERATED_DIR);
  assert.equal(normalizeDestination("a/../b"), GENERATED_DIR);
  assert.equal(normalizeDestination("./x"), GENERATED_DIR);
});

test("the Setup folder shown is the folder saved into, from the first paint and across project switches", async () => {
  const { store } = makeStore("notes/out/");
  assert.equal(store.getSnapshot().destination, "notes/out", "remembered folder shown on first paint");
  await store.setProject("/p/one");
  assert.equal(store.getSnapshot().destination, "notes/out");
  await store.setProject("/p/two");
  assert.equal(store.getSnapshot().destination, "notes/out", "a project switch keeps the Setup folder");
  store.setDestination("");
  assert.equal(store.getSnapshot().destination, GENERATED_DIR);
});

test("Save chat output writes each reply once as chat-output files and never touches the document", async () => {
  const { store, fs } = makeStore();
  await store.setProject("/p/one");
  await store.saveChatReply("first reply");
  await store.saveChatReply("first reply");
  assert.equal(fs.writes.length, 1, "pressing Save again for the same reply writes nothing");
  assert.equal(store.getSnapshot().chatSaved?.path, `${GENERATED_DIR}/chat-output.md`);
  await store.saveChatReply("second reply");
  assert.equal(store.getSnapshot().chatSaved?.path, `${GENERATED_DIR}/chat-output-2.md`, "a new reply gets its own file");
  assert.equal(fs.files.get(`${GENERATED_DIR}/chat-output-2.md`)!.text, "second reply\n");
  assert.equal(store.run.getSnapshot().phase, "idle", "the document run is untouched");
  assert.equal(store.run.getSnapshot().saved, null);
});

test("Save chat output reports a failed write and leaves the saved state alone", async () => {
  const { store, fs } = makeStore();
  await store.setProject("/p/one");
  fs.write = async () => { throw new FsErr("io"); };
  await store.saveChatReply("reply");
  assert.equal(store.getSnapshot().chatSaved, null);
  assert.match(store.getSnapshot().chatSaveError!.message, /file system/);
});

test("refine resolves true when a revision applies and false when it is refused or fails (the UI keeps the typed text)", async () => {
  const c = controllableApi();
  const run = new GenerationRun({ api: c.api, readers: readersFrom({ "a.md": "alpha" }), fs: new MemFs() });
  const g = run.generate({ template: null, command: "Summarize", prompt: "" }, [fileItem("a.md", 5)]);
  await tick();
  c.calls[0]!.resolve(okResult("DOC1"));
  await g;

  const ok = run.refine("shorter");
  await tick();
  c.calls[1]!.resolve(okResult("DOC2"));
  assert.equal(await ok, true);
  assert.equal(run.getSnapshot().doc, "DOC2");

  const bad = run.refine("again");
  await tick();
  c.calls[2]!.reject(Object.assign(new Error("boom"), { code: "INTERNAL_ERROR", status: 500 }));
  assert.equal(await bad, false);
  assert.equal(run.getSnapshot().doc, "DOC2", "a failed revision keeps the document");
  assert.ok(run.getSnapshot().editError);

  assert.equal(await run.refine("   "), false, "an empty instruction is not sent");
});

test("Save chat output pressed twice while the first write is in flight writes the reply once", async () => {
  const { store, fs } = makeStore();
  await store.setProject("/p/one");
  await Promise.all([store.saveChatReply("same reply"), store.saveChatReply("same reply")]);
  assert.equal(fs.writes.length, 1, "a double press must not create chat-output-2.md with the same text");
  assert.equal(store.getSnapshot().chatSaved?.path, `${GENERATED_DIR}/chat-output.md`);
});
