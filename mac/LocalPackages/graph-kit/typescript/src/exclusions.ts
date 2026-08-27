// Directory names that hold third-party or generated content, never memory or
// first-party code. Shared by the text walker (memoryGenerator) and the code
// scanner (tsScanner) so the two cannot drift apart again. Dotted directories
// (.git, .graphkit, …) are excluded separately by each walker's
// `name.startsWith(".")` check and do not belong here.
export const EXCLUDED_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "vendor",
  "coverage",
  "target",
  "Pods",
  "DerivedData",
  "__pycache__",
]);
