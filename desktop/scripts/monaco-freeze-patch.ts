// Monaco assigns `toString` on plain namespace objects at module init:
//   KeyCodeUtils.toString = toString; Severity.toString = ...; MarkerSeverity.toString = ...;
//   id.toString = () => serviceId; InlineSuggestAlternativeAction.toString = ...;
// Under Tauri's `freezePrototype` (Object.freeze(Object.prototype), a hardening we keep) a strict-mode
// assignment to the inherited, now non-writable `toString` throws:
//   WebKit: "Attempted to assign to readonly property."
// The Explorer then shows "The editor could not load" and no file opens.
//
// This rewrites just those assignments into `Object.defineProperty(...)`, which creates an own writable
// property instead of assigning through the prototype. It is applied to the five Monaco files that do it
// (source and esbuild pre-bundle); prototype patches in language services (e.g. OutputLine.prototype.toString)
// are left untouched because they create an own property on their own prototype objects.
export const MONACO_FROZEN_FILES: ReadonlySet<string> = new Set([
  "keyCodes.js",
  "severity.js",
  "markers.js",
  "instantiation.js",
  "InlineSuggestAlternativeAction.js",
]);

/** Basename of a module id from either OS. */
export function baseName(id: string): string {
  return id.split(/[\\/]/).pop() ?? "";
}

export function isMonacoEsm(id: string): boolean {
  return /monaco-editor[\\/]esm[\\/]/.test(id);
}

/** True when this module id is one the patch applies to. */
export function needsPatch(id: string): boolean {
  return isMonacoEsm(id) && MONACO_FROZEN_FILES.has(baseName(id));
}

const ASSIGN = /(?<![\w$.])([A-Za-z_$][\w$]*)\.toString = ([^;\n]+);/g;

/**
 * Rewrites `<ns>.toString = <rhs>;` into `Object.defineProperty(<ns>, "toString", {...});`.
 * Only for the known files; any other input is returned unchanged. Idempotent.
 */
export function patchMonacoSource(code: string, file: string): string {
  if (!MONACO_FROZEN_FILES.has(file)) return code;
  if (!ASSIGN.test(code)) return code;
  ASSIGN.lastIndex = 0;
  return code.replace(ASSIGN, 'Object.defineProperty($1, "toString", { value: $2, writable: true, configurable: true });');
}
