// Kill switches of the session router (K1 Phase 6b, plan section 14.9).
//
// Every part that can change which model answers or how many tokens a chat
// may spend is OFF unless its variable is exactly "on". Read at call time, so
// a test (or an operator) can flip one without a restart of the module graph.
// There is deliberately NO auto-switch flag: the router never changes the
// pick on its own because a cache expired (user answer Q-R3, 2026-10-30).
//
//   LLMIDE_ROUTER=on            the per-chat route row, PUT/GET routes' effect, switch rules
//   LLMIDE_ROUTER_CAP=on        session token cap enforcement (needs LLMIDE_ROUTER=on)
//   LLMIDE_ROUTER_COMPRESS=on   adapter-turn prompt compression (needs LLMIDE_ROUTER=on)
//   LLMIDE_ROUTER_LEARN=on      learned per-key limits read by pickTurnProvider

const on = (name, env) => env[name] === 'on';

export function routerEnabled(env = process.env) { return on('LLMIDE_ROUTER', env); }
export function routerCapEnabled(env = process.env) { return routerEnabled(env) && on('LLMIDE_ROUTER_CAP', env); }
export function routerCompressEnabled(env = process.env) { return routerEnabled(env) && on('LLMIDE_ROUTER_COMPRESS', env); }
/** Learned limits are read by the existing fallback pick, so they do not need the router row. */
export function routerLearnEnabled(env = process.env) { return on('LLMIDE_ROUTER_LEARN', env); }
