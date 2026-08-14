// One-shot generator: build the committed llm_default_sources snapshot at the
// repo root from the real environment (registry + per-user enable state).
// Usage: cd extension && node scripts/gen-default-sources.mjs
// (The server also does this automatically at boot — this is for generating
//  the initial committed copy without waiting for a server restart.)
const { seedBuiltinOnce, DEFAULT_SOURCES_ID } = await import('../llm-sources/registry.mjs');
const { enableDefaultSourcesOnce, listStateUserIds } = await import('../llm-sources/state.mjs');
const { refreshDefaultSnapshot } = await import('../llm_agent/default-snapshot.mjs');

seedBuiltinOnce();
enableDefaultSourcesOnce(DEFAULT_SOURCES_ID);
const users = listStateUserIds();
if (users.length === 0) {
  console.log('No users with enable state — nothing generated.');
} else {
  for (const uid of users) {
    const r = refreshDefaultSnapshot(uid);
    console.log(uid, JSON.stringify(r.counts), r.dir);
  }
}
