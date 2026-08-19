// Single source of truth for the set of "global" (repo-independent)
// handler names that the /code-assist agent loop can dispatch to.
//
// Why this file exists: route.mjs builds a `handlers` object (via
// registry.buildDispatch) keyed by these names (the ACTUAL dispatch
// table), and skills/registry.mjs checks every global 'read' skill file
// against a GLOBAL_HANDLED set (the STARTUP SANITY CHECK) to catch a
// skill shipped with no handler. Those two lists used to be maintained
// as separate hardcoded literals in two different files — nothing
// enforced that they stayed equal, so adding a handler to route.mjs
// without remembering the registry.mjs copy (or vice versa) shipped
// silently.
//
// Both the name list here and route.mjs's actual dispatch table now
// derive from the same place — llm_agent/tools/registry.mjs — so there
// is exactly one place a handler's name and dispatch logic are declared;
// this file is a thin re-export so existing importers (route.mjs,
// skills/registry.mjs, tests) keep their current import path and the
// frozen-array shape they expect.
//
// To add a new global handler: add its entry to
// llm_agent/tools/registry.mjs's ENTRIES — this file and route.mjs's
// dispatch table both pick it up automatically.
import { names } from '../tools/registry.mjs';

export const GLOBAL_HANDLER_NAMES = Object.freeze(names());
