// Single source of truth for the set of "global" (repo-independent)
// handler names that the /code-assist agent loop can dispatch to.
//
// Why this file exists: route.mjs builds a `handlers` object keyed by
// these names (the ACTUAL dispatch table), and skills/registry.mjs
// checks every global 'read' skill file against a GLOBAL_HANDLED set
// (the STARTUP SANITY CHECK) to catch a skill shipped with no handler.
// Those two lists used to be maintained as separate hardcoded literals
// in two different files — nothing enforced that they stayed equal, so
// adding a handler to route.mjs without remembering the registry.mjs
// copy (or vice versa) shipped silently. `route.mjs` and
// `skills/registry.mjs` now both import GLOBAL_HANDLER_NAMES from here
// instead of hardcoding their own list, and a regression test
// (tests/global-handlers-sync.test.mjs) asserts route.mjs's real
// `handlers` object keys equal this array exactly — so a mismatch
// fails the test suite instead of shipping.
//
// To add a new global handler: add its name here, add the branch to
// the `handlers` object in route.mjs, done — the startup check and the
// regression test both pick it up automatically.
export const GLOBAL_HANDLER_NAMES = Object.freeze([
  'ask-internal',
  'ask-subagent',
  'web-search',
  'fetch-url',
  'list-files',
  'read-file',
]);
