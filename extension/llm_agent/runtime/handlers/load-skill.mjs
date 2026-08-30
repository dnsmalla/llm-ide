// Read handler: resolve a skill id from the user's library to its
// followable SKILL.md text, so a skill that ends by naming another skill
// can actually hand over to it (see llm_agent/global/load-skill.md, and
// runtime/plan-pipeline.mjs for the planning pipeline that depends on it).
//
// SECURITY: `readSkill` is the catalog-gated reader (skills/skill-library.mjs
// readSkillInstructions) — it looks the id up in the user's ENABLED sources
// and reads the path IT knows, never a path from the wire. That is what
// makes the returned text safe to frame as trusted instructions. Injected
// so tests (and any future per-request scoping) control the lookup rather
// than this module reaching for a singleton.
//
// An unknown id returns an error OBJECT rather than throwing: the loop feeds
// it back to the model, and a model that guessed "writing-plans" instead of
// "skills/writing-plans" can correct itself from the `available` list in the
// same turn instead of ending the turn on a tool failure.

import { redactFence } from '../redaction.mjs';

// How many ids to name back on a miss. Enough to recover from a plausible
// typo, bounded so a user with a large library can't turn one bad id into a
// multi-kilobyte tool result.
const MAX_SUGGESTIONS = 40;

// The skills module is loaded LAZILY, not with a static import. A static one
// would close a real cycle — tools/registry.mjs imports this handler,
// skills/registry.mjs imports runtime/global-handlers.mjs, and that derives
// its name list from tools/registry.mjs's ENTRIES at module scope. Under
// that cycle ENTRIES is still undefined when global-handlers runs, so the
// whole agent surface breaks at boot rather than here. Resolving at CALL
// time keeps this handler a leaf. Cached after the first await so a chatty
// turn pays one dynamic import, not one per call.
let _skillsModule = null;
async function skillsModule() {
  if (!_skillsModule) _skillsModule = await import('../../skills/index.mjs');
  return _skillsModule;
}

export async function handleLoadSkill(args, ctx = {}) {
  const mod = (ctx.readSkill && ctx.listSkills) ? null : await skillsModule();
  const readSkill = ctx.readSkill || mod.readSkillInstructions;
  const listSkills = ctx.listSkills || mod.listSkillLibrary;
  const id = typeof args?.id === 'string' ? args.id.trim() : '';
  if (!id) return { error: 'missing skill id', hint: 'Pass `id` as "<family>/<dir>", e.g. "skills/writing-plans".' };

  const skill = readSkill(id, ctx.userId);
  if (skill) {
    return {
      id: skill.id,
      name: redactFence(skill.name || ''),
      // Redacted like every other tool result: the loop's <<<TOOL_RESULT>>>
      // fence is the boundary the model parses on, and a SKILL.md that
      // happens to document a fence would otherwise close it early.
      content: redactFence(skill.content || ''),
    };
  }

  let available = [];
  try {
    const { skills } = listSkills(ctx.userId);
    available = (Array.isArray(skills) ? skills : [])
      .slice(0, MAX_SUGGESTIONS)
      .map((s) => redactFence(s.id));
  } catch { /* a broken catalog must not turn a miss into a thrown tool */ }

  return {
    error: 'unknown skill id',
    id: redactFence(id),
    hint: 'Ids are "<family>/<dir>". Pick one of `available`, or continue without the skill.',
    available,
  };
}
