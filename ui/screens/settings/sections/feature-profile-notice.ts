/** The one notice shown after a feature profile save: the dependency drop (if any) and the saved confirmation. */
export function savedProfileNotice(droppedNames: string): string {
  const saved = "Saved. The change applies the next time the app opens.";
  return droppedNames ? `Also turned off: ${droppedNames}. ${saved}` : saved;
}
