// File name -> Monaco language id. Pure. Covers the languages the Mac app highlights plus common config.
const BY_EXT: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", jsonc: "json", json5: "json", md: "markdown", markdown: "markdown", mdx: "markdown",
  py: "python", pyi: "python", rs: "rust", go: "go", java: "java", kt: "kotlin", kts: "kotlin",
  swift: "swift", m: "objective-c", mm: "objective-c", c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp",
  hpp: "cpp", hh: "cpp", cs: "csharp", rb: "ruby", php: "php", sh: "shell", bash: "shell", zsh: "shell",
  ps1: "powershell", psm1: "powershell", bat: "bat", cmd: "bat", yaml: "yaml", yml: "yaml", toml: "ini", ini: "ini",
  cfg: "ini", conf: "ini", html: "html", htm: "html", xml: "xml", svg: "xml", plist: "xml", xib: "xml",
  css: "css", scss: "scss", less: "less", sql: "sql", graphql: "graphql", gql: "graphql", lua: "lua",
  r: "r", dart: "dart", scala: "scala", pl: "perl", tf: "hcl", proto: "protobuf", vue: "html", svelte: "html",
  csv: "plaintext", txt: "plaintext", log: "plaintext",
};

const BY_NAME: Record<string, string> = {
  dockerfile: "dockerfile", makefile: "makefile", gnumakefile: "makefile", cmakelists: "cmake",
  gemfile: "ruby", rakefile: "ruby", podfile: "ruby", ".gitignore": "ini", ".env": "ini", ".editorconfig": "ini",
  "package.swift": "swift",
};

export function languageFor(path: string): string {
  const name = (path.includes("/") ? path.slice(path.lastIndexOf("/") + 1) : path).toLowerCase();
  const byName = BY_NAME[name];
  if (byName) return byName;
  if (name.startsWith("dockerfile.")) return "dockerfile";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "plaintext";
  return BY_EXT[name.slice(dot + 1)] ?? "plaintext";
}
