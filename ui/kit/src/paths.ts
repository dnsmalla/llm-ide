// Path helpers shared by the screens. Pure, so node tests import them directly.
// Two path worlds: root-relative paths ("" is the project root, "/" separated) and absolute
// server paths (POSIX). `joinRel` and `joinAbs` are different on purpose; do not merge them.

/** A child of a root-relative folder (`""` is the root). */
export function joinRel(dir: string, name: string): string {
  return dir === "" ? name : `${dir}/${name}`;
}

/** A child of an absolute path. The root `/` is the one place a separator is not added. */
export function joinAbs(parent: string, name: string): string {
  return parent.endsWith("/") ? `${parent}${name}` : `${parent}/${name}`;
}

/** The folder part of a root-relative path (`""` at the top). */
export function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/** The last `/` segment of a root-relative path (`""` for a trailing slash). */
export function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

/** Last segment of a native OS path. Project roots are not `/`-only: on Windows the root is `C:\...`. */
export function nativeBaseName(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
}

/**
 * The last non-empty segment, or the whole path when there is none. `"native"` splits on `/` and `\`;
 * `"posix"` only on `/` (a server path, where a backslash is a legal name character).
 */
export function lastSegment(path: string, separators: "native" | "posix" = "native"): string {
  const parts = separators === "posix" ? path.split("/") : path.split(/[\\/]/);
  return parts.filter(Boolean).pop() ?? path;
}
