// What would be lost if the project changed right now. A project switch remounts every section (the shell keys them
// by project root), and a section's unsaved state lives in that section, so the shell cannot see it. Each section
// that can hold unsaved work registers one source here; the project store asks before it lets a switch through.

/** Returns a short sentence naming the unsaved work ("2 unsaved files in Explorer"), or null when there is none. */
export type UnsavedSource = () => string | null;

const sources = new Set<UnsavedSource>();

export const unsavedWork = {
  /** Registers a source; the returned function removes it (call it on unmount). */
  register(source: UnsavedSource): () => void {
    sources.add(source);
    return () => { sources.delete(source); };
  },
  /** One line per section that has unsaved work right now. A source that throws counts as nothing to lose. */
  list(): string[] {
    const out: string[] = [];
    for (const source of sources) {
      try {
        const label = source();
        if (label) out.push(label);
      } catch { /* a broken source must not block every project switch */ }
    }
    return out;
  },
};
