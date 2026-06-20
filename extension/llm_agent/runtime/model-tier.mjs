// Resolves the upstream model id for a /code-assist request from an
// optional explicit model and an optional tier hint.
//
//   • An explicit `model` always wins.
//   • tier "subagent" routes to LLMIDE_SUBAGENT_MODEL — the cheap tier
//     for short judge / verify-author calls. When that env var is unset
//     it resolves to `undefined`, so runClaude falls back to its default
//     model (safe: you lose the cost saving, not correctness).
//   • Any other or absent tier → `undefined` (the normal global model).
//
// Pure and env-injectable so it can be unit-tested without the server.
export function resolveTierModel({ model, tier } = {}, env = process.env) {
  if (model) return model;
  if (tier === 'subagent') return env.LLMIDE_SUBAGENT_MODEL || undefined;
  return undefined;
}
