// Pure workspace state rules. No React and no Host API: the screen and its tests share these.
export const dirtyOf = (buffer: string, saved: string): boolean => buffer !== saved;
export const conflictText = (reason: string): string =>
  `The file changed on the host (${reason}). Reload it before saving again.`;
export const saveAllowed = (s: { dirty: boolean; saving: boolean }): boolean => s.dirty && !s.saving;
