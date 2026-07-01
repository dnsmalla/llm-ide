// Back-compat shim for the MeetNotes → LLM IDE rename.
//
// Config and other modules now read `LLMIDE_*` environment variables, but
// existing deployments may still set the old `MEETNOTES_*` names. For each old
// var present, alias it to the new name when the new one isn't already set.
//
// This MUST run before any module reads configuration, so it is imported as the
// very first import in server.mjs (ES module imports execute depth-first in
// source order, so anything imported afterward sees the aliased values).
for (const [key, value] of Object.entries(process.env)) {
  if (key.startsWith('MEETNOTES_')) {
    const renamed = 'LLMIDE_' + key.slice('MEETNOTES_'.length);
    if (process.env[renamed] === undefined) {
      process.env[renamed] = value;
    }
  }
}
