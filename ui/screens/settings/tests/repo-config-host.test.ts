import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  addSavedRepo,
  clearRepoConfigHostFile,
  defaultRepoConfig,
  hydrateRepoConfig,
  setRepoConfigHostIo,
  writeRepoConfig,
} from "../repo-config.ts";

const KEY = "llmide.repos.config";
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

const mem = (): Storage => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    get length() { return m.size; },
  } as unknown as Storage;
};

/** A fake host copy: `file` is what the host would return; a failing load or save is a refused host command. */
function fakeHost(initial: string | null = null, opts: { loadError?: boolean; saveError?: boolean } = {}) {
  const saves: string[] = [];
  const state = { file: initial as string | null };
  return {
    saves,
    get file() { return state.file; },
    io: {
      async load(): Promise<string | null> {
        if (opts.loadError) throw new Error("malformed");
        return state.file;
      },
      async save(json: string): Promise<void> {
        if (opts.saveError) throw new Error("refused");
        saves.push(json);
        state.file = json;
      },
    },
  };
}

afterEach(() => setRepoConfigHostIo(undefined));

test("a host copy is written into empty webview storage at start-up", async () => {
  const host = fakeHost('{"primary":"github","saved":{"gitlab":[],"github":[]}}');
  const storage = mem();
  assert.equal(await hydrateRepoConfig(storage, host.io), "restored");
  assert.equal(storage.getItem(KEY), '{"primary":"github","saved":{"gitlab":[],"github":[]}}');
  assert.deepEqual(host.saves, [], "a restore does not write back");
});

test("the host copy wins over a different webview copy", async () => {
  const host = fakeHost('{"primary":"gitlab"}');
  const storage = mem();
  storage.setItem(KEY, '{"primary":"github"}');
  assert.equal(await hydrateRepoConfig(storage, host.io), "restored");
  assert.equal(storage.getItem(KEY), '{"primary":"gitlab"}');
});

test("a list saved only in webview storage is migrated to the host once", async () => {
  const host = fakeHost(null);
  const storage = mem();
  storage.setItem(KEY, '{"primary":"gitlab"}');
  assert.equal(await hydrateRepoConfig(storage, host.io), "migrated");
  assert.equal(host.file, '{"primary":"gitlab"}');
  // The host copy now exists, so the next start restores it rather than migrating again.
  assert.equal(await hydrateRepoConfig(mem(), host.io), "restored");
});

test("nothing anywhere leaves both copies alone", async () => {
  const host = fakeHost(null);
  assert.equal(await hydrateRepoConfig(mem(), host.io), "unchanged");
  assert.deepEqual(host.saves, []);
});

test("an unreadable host copy is left alone and the webview copy is not replaced", async () => {
  const host = fakeHost(null, { loadError: true });
  const storage = mem();
  storage.setItem(KEY, '{"primary":"gitlab"}');
  assert.equal(await hydrateRepoConfig(storage, host.io), "unchanged");
  assert.equal(storage.getItem(KEY), '{"primary":"gitlab"}');
  assert.deepEqual(host.saves, [], "the host file is not overwritten from a broken read");
});

test("a webview copy that is not a JSON object is not migrated", async () => {
  const host = fakeHost(null);
  const storage = mem();
  storage.setItem(KEY, "not json");
  assert.equal(await hydrateRepoConfig(storage, host.io), "unchanged");
  assert.deepEqual(host.saves, []);
});

test("writes go through to the host copy as well as webview storage", async () => {
  const host = fakeHost(null);
  setRepoConfigHostIo(host.io);
  const storage = mem();
  const cfg = addSavedRepo(defaultRepoConfig(), "github");
  writeRepoConfig(cfg, storage);
  await tick();
  assert.equal(storage.getItem(KEY), JSON.stringify(cfg));
  assert.equal(host.file, JSON.stringify(cfg));
});

test("a refused host write keeps the webview copy for this session", async () => {
  const host = fakeHost(null, { saveError: true });
  setRepoConfigHostIo(host.io);
  const storage = mem();
  const cfg = addSavedRepo(defaultRepoConfig(), "gitlab");
  assert.doesNotThrow(() => writeRepoConfig(cfg, storage));
  await tick();
  assert.equal(storage.getItem(KEY), JSON.stringify(cfg));
});

test("the forget path empties the host copy as well", async () => {
  const host = fakeHost('{"primary":"gitlab"}');
  setRepoConfigHostIo(host.io);
  clearRepoConfigHostFile();
  await tick();
  assert.equal(host.file, "{}");
  // An empty object reads back as the defaults, so a later start does not bring the list back.
  assert.equal(await hydrateRepoConfig(mem(), host.io), "restored");
});

test("with no host (plain browser), nothing is persisted and hydrate does nothing", async () => {
  setRepoConfigHostIo(null);
  const storage = mem();
  writeRepoConfig(defaultRepoConfig(), storage);
  assert.equal(await hydrateRepoConfig(storage, null), "unchanged");
  assert.ok(storage.getItem(KEY) !== null, "the webview copy is still written");
});
