---
name: ask-user
kind: write
confirmation: question-card
schema:
  question:
    type: string
    required: true
    maxLength: 500
    description: the question, as one clear sentence ending in "?".
  options:
    type: string[]
    required: true
    description: 2-4 short answer labels the user picks from, your recommended one FIRST (e.g. ["Keep the cache (Recommended)", "Remove it"]).
  header:
    type: string
    maxLength: 40
    description: optional short topic label shown on the card (at most 12 characters reads best, e.g. "Database").
  multiSelect:
    type: boolean
    description: true when more than one option may be picked; default false.
---

# ask-user

Ask the user a question whose answer is one of a few fixed choices. The app
shows it as a card with the options as buttons; the user taps one, and their
choice comes back to you as this tool's result so you can continue.

Use it whenever you would otherwise write "Which do you prefer: A, B or C?" —
picking an approach, a file or target, keep vs. replace, a yes/no with a named
alternative. Do NOT use it for open-ended questions (a name, a description,
"what should this do?") — ask those in your reply — and never ask what you can
find out yourself with the read tools.

Rules:
- One question per call, 2-4 options. Put your recommendation first and mark
  it, e.g. "Use SQLite (Recommended)".
- Asking ends your turn: write at most one short line of context before the
  call, not the options again — the card shows them.
- Ask only what changes what you do next. If several questions are
  independent, ask the most important one first; you can ask the next after
  the answer arrives.

## Call shape

<<<TOOL_CALL>>>
{"name": "ask-user", "arguments": {
  "question": "Which storage should the cache use?",
  "header": "Storage",
  "options": ["SQLite (Recommended)", "In-memory only", "Files on disk"]
}}
<<<END_TOOL_CALL>>>
