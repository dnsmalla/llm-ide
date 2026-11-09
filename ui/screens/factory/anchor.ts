// The Factory section's focus anchor: a `goto-section` request carries `item:<work item key>`, so another screen
// (Issues → Send to Factory) can open the board on one card. No imports: the always-compiled entry uses this alone.

export function factoryAnchor(key: string): string {
  return `item:${key}`;
}

/** The item key in a Factory anchor, or null for any other anchor (a wrong section must not focus a card). */
export function focusKeyFromAnchor(anchor: string | undefined): string | null {
  return typeof anchor === "string" && anchor.startsWith("item:") && anchor.length > 5 ? anchor.slice(5) : null;
}
