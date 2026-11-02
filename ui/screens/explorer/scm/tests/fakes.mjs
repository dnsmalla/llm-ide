// In-memory ScmApi for controller and component tests.
export class ScmErr extends Error {
  constructor(code, message = code) { super(message); this.code = code; }
}

export function entry(path, index = ".", worktree = "M", kind = "changed", extra = {}) {
  return { path, orig_path: null, index, worktree, kind, submodule: false, ...extra };
}

/** A stable 40-hex id per stash message (messages are unique in these tests). */
export function fakeHash(message) {
  return Buffer.from(message).toString("hex").padEnd(40, "0").slice(0, 40);
}

export function makeScm(init = {}) {
  const calls = [];
  const state = {
    entries: init.entries ?? [],
    truncated: false,
    branch: "main",
    identity: init.identity === undefined ? { name: "Ada", email: "ada@example.com" } : init.identity,
    failNext: null,
    hunkDiff: init.hunkDiff ?? { diff_id: "id1", truncated: false, hunks: [
      { index: 0, header: "@@ -1,3 +1,3 @@", added: 1, removed: 1, lines: ["-a", "+b", " c"] },
      { index: 1, header: "@@ -9,3 +9,3 @@", added: 2, removed: 0, lines: ["+x", "+y", " z"] },
    ] },
    log: init.log ?? [],
    branches: init.branches ?? [{ name: "main", current: true, hash: "abc1234", upstream: null }],
    gate: null,
    tags: init.tags ?? [],
    tagsTruncated: init.tagsTruncated ?? false,
    tagsError: init.tagsError ?? null,
    unmerged: init.unmerged ?? [],
    stashes: init.stashes ?? [],
  };
  // Like the host: the entry must still sit at that index with that hash, else `changed`.
  const stashAt = (index, hash) => {
    if (!state.stashes[index]) throw new ScmErr("not_found", "no such stash");
    if (fakeHash(state.stashes[index]) !== hash) throw new ScmErr("changed", "the stash list changed since it was shown");
  };
  const rec = (name, ...args) => { calls.push([name, ...args]); if (state.failNext) { const e = state.failNext; state.failNext = null; throw e; } };
  const api = {
    calls, state,
    async status() { rec("status"); if (state.gate) await state.gate; return { branch: state.branch, head: "abc", upstream: null, ahead: 0, behind: 0, entries: state.entries, truncated: state.truncated }; },
    async stage(paths, stage) { rec("stage", paths, stage); },
    async stageAll(stage) { rec("stageAll", stage); },
    async diffHunks(path, staged) { rec("diffHunks", path, staged); return state.hunkDiff; },
    async stageHunks(path, staged, id, hunks) { rec("stageHunks", path, staged, id, hunks); },
    async discard(paths) { rec("discard", paths); return { restored: paths.length, trashed: 0 }; },
    async identity() { rec("identity"); if (!state.identity) throw new ScmErr("identity_missing"); return state.identity; },
    async commit(message) { rec("commit", message); return { hash: "deadbee" }; },
    async branchesList() { return null; },
    async branches() { rec("branches"); return { branches: state.branches, truncated: false }; },
    async tags() { rec("tags"); if (state.tagsError) throw state.tagsError; return { tags: state.tags, truncated: state.tagsTruncated }; },
    async checkout(name) { rec("checkout", name); },
    async createBranch(name) { rec("createBranch", name); },
    async log(skip, limit) { rec("log", skip, limit); return { entries: state.log.slice(skip, skip + limit), has_more: skip + limit < state.log.length }; },
    async commitFiles(hash) { rec("commitFiles", hash); return { hash, parents: [], message: "msg\n\nbody", files: [{ status: "M", path: "a.txt" }], truncated: false }; },
    async branchDelete(name, force) {
      rec("branchDelete", name, force);
      if (state.unmerged.includes(name) && !force) return { status: "not_merged", tip: "def5678", unique_commits: 2 };
      state.branches = state.branches.filter((b) => b.name !== name);
      return { status: "deleted" };
    },
    async tagCreate(name, message, target) {
      rec("tagCreate", name, message, target);
      if (state.tags.some((t) => t.name === name)) throw new ScmErr("exists", `a tag named ${name} already exists`);
      const tag = { name, target: "abc1234", annotated: !!message };
      state.tags = [...state.tags, tag];
      return tag;
    },
    async stashList() {
      rec("stashList");
      return { stashes: state.stashes.map((message, index) => ({ index, hash: fakeHash(message), message })), truncated: false };
    },
    async stashPush(message, includeUntracked) {
      rec("stashPush", message, includeUntracked);
      state.stashes = [message || "WIP on main", ...state.stashes];
    },
    async stashApply(index, hash) { rec("stashApply", index, hash); stashAt(index, hash); },
    async stashPop(index, hash) { rec("stashPop", index, hash); stashAt(index, hash); state.stashes = state.stashes.filter((_, i) => i !== index); },
    async stashDrop(index, hash) { rec("stashDrop", index, hash); stashAt(index, hash); state.stashes = state.stashes.filter((_, i) => i !== index); },
    async commitDiff(hash, path) { rec("commitDiff", hash, path); return { text: "@@ -1 +1 @@\n-a\n+b‮\n", truncated: false }; },
  };
  return api;
}
