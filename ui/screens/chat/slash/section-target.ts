/** `<section>` or `<section>:<pane>` as the shell bus wants it: the pane is everything after the first colon. */
export function splitSectionTarget(section: string): { base: string; pane: string } {
  const i = section.indexOf(":");
  return i < 0 ? { base: section, pane: "" } : { base: section.slice(0, i), pane: section.slice(i + 1) };
}
