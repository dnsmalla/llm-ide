// Pure workspace state rules. No React and no Host API: the screen and its tests share these.
export const dirtyOf = (buffer: string, saved: string): boolean => buffer !== saved;
export const conflictText = (reason: string): string =>
  `The file changed on the host (${reason}). Reload it before saving again.`;
export const saveAllowed = (s: { dirty: boolean; saving: boolean }): boolean => s.dirty && !s.saving;

export const parentOf = (path: string): string => {
  const clean = path.replace(/\/+$/, "");
  const at = clean.lastIndexOf("/");
  return at <= 0 ? "" : clean.slice(0, at);
};
export const joinPath = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);
export const isTextLike = (path: string): boolean => !/\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|woff2?|ttf|otf|mp[34]|mov|db|sqlite|wasm)$/i.test(path);
