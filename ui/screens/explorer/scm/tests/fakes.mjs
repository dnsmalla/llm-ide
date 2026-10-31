// In-memory ScmApi for controller and component tests.
export class ScmErr extends Error {
  constructor(code, message = code) { super(message); this.code = code; }
}

export function entry(path, index = ".", worktree = "M", kind = "changed", extra = {}) {
  return { path, orig_path: null, index, worktree, kind, submodule: false, ...extra };
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
    async checkout(name) { rec("checkout", name); },
    async createBranch(name) { rec("createBranch", name); },
    async log(skip, limit) { rec("log", skip, limit); return { entries: state.log.slice(skip, skip + limit), has_more: skip + limit < state.log.length }; },
    async commitFiles(hash) { rec("commitFiles", hash); return { hash, parents: [], message: "msg\n\nbody", files: [{ status: "M", path: "a.txt" }], truncated: false }; },
    async commitDiff(hash, path) { rec("commitDiff", hash, path); return { text: "@@ -1 +1 @@\n-a\n+b‮\n", truncated: false }; },
  };
  return api;
}
