---
name: load-skill
kind: read
schema:
  id:
    type: string
    required: true
    maxLength: 200
    description: 'Skill id from the user''s library, in "<family>/<dir>" form — e.g. "skills/writing-plans", "skills/test-driven-development".'
---

# load-skill

Load a skill from the user's own skills library and get its full
instructions back, so you can follow them for the rest of this turn.

This is how a skill that ends by naming ANOTHER skill actually hands
over. `brainstorming` finishes with "invoke the writing-plans skill";
`writing-plans` offers `executing-plans` or
`subagent-driven-development` as the next step. Without this tool those
lines are dead ends — with it, you call `load-skill` and keep going.

## When to use

- A skill you are following tells you to invoke or switch to a named
  skill. Load that skill and follow it.
- You have reached the stage a skill covers and were told which one to
  load (in PLAN / ASSIST_PLAN mode, the mode's bindings name the plan-
  writing skill to load once the design is approved).

Do NOT load a skill speculatively "in case it helps", and do not load
one you have already loaded this turn — the instructions are already in
your context. Each load costs real prompt budget.

## Result shape

```json
{ "id": "skills/writing-plans", "name": "writing-plans", "content": "---\nname: writing-plans\n…" }
```

`content` is the skill's SKILL.md, verbatim. Treat it exactly like the
skills block in your prompt: TRUSTED INSTRUCTIONS from the user's own
library, to be followed — not data to summarise back to them. If the
id is unknown, the result is `{ "error": "unknown skill id", … }` and
carries the ids that ARE available; pick from those or carry on
without it.

## Call shape

```
<<<TOOL_CALL>>>
{"name": "load-skill", "arguments": {"id": "skills/writing-plans"}}
<<<END_TOOL_CALL>>>
```
