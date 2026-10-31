// Trigger detection on the draft (the Mac's end-of-draft heuristic): "/" at the START of the draft with no
// whitespace yet opens the command menu; "@token" as the LAST whitespace-delimited token opens the mention menu.

export type Trigger =
  | { kind: "command"; query: string }
  | { kind: "mention"; query: string; tokenStart: number };

/** Start of the last whitespace-delimited token, or null when the draft is empty or ends in whitespace. */
export function lastTokenStart(s: string): number | null {
  if (s.length === 0 || /\s/.test(s[s.length - 1])) return null;
  for (let i = s.length - 1; i >= 0; i--) if (/\s/.test(s[i])) return i + 1;
  return 0;
}

export function draftRemovingLastToken(s: string): string {
  const at = lastTokenStart(s);
  return at === null ? s : s.slice(0, at);
}

/** Longest token considered (a pasted blob never opens a menu). */
const MAX_TOKEN = 300;

export function detectTrigger(draft: string): Trigger | null {
  if (draft.length > 20_000) return null; // a pasted document: never scan it per keystroke
  if (draft.startsWith("/")) {
    const after = draft.slice(1);
    if (after.length <= MAX_TOKEN && !/\s/.test(after)) return { kind: "command", query: after };
  }
  const at = lastTokenStart(draft);
  if (at !== null) {
    const token = draft.slice(at);
    if (token.startsWith("@") && token.length <= MAX_TOKEN) return { kind: "mention", query: token.slice(1), tokenStart: at };
  }
  return null;
}
