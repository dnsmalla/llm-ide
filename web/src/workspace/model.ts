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

/** Porcelain `XY` -> one short label the Changes list can show. */
export const statusLabel = (x: string, y: string): string => {
  if (x === "?" && y === "?") return "U";
  if (x === "R" || y === "R") return "R";
  if (x === "C" || y === "C") return "C";
  if (x === "A" || y === "A") return "A";
  if (x === "D" || y === "D") return "D";
  return "M";
};

export const commitReady = (message: string, paths: readonly string[], busy: boolean): boolean =>
  !busy && message.trim().length > 0 && paths.length > 0;
