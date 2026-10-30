// The instruction scan (plan section 7). Heuristic and WARN-ONLY (user
// decision, 2026-10-30): it never blocks an install or an enable, it tells the
// user what to look at. A clean scan is not a promise of safety; the output
// says so by being called `findings`, not `verdict`.
//
// Pure: takes the files of a tree (Map<path, Buffer>), returns findings.

const MAX_FINDINGS = 200;
const MAX_SCAN_BYTES = 512 * 1024;
const TEXT_EXT = /\.(md|mdx|txt|json|ya?ml|toml|sh|bash|zsh|js|mjs|cjs|ts|py|rb|ini|cfg|env)$/i;

// zero-width, bidi controls, tag characters, a BOM past the first character
const HIDDEN_RE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\u{e0000}-\u{e007f}]|(?<!^)\ufeff/u;

const RULES = [
  { rule: 'injection_phrase', re: /\b(ignore|disregard|forget)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all)\b[^.\n]{0,30}\b(instructions?|prompts?|rules)\b/i,
    detail: 'reads like an instruction to override the assistant\'s earlier instructions' },
  { rule: 'injection_phrase', re: /\b(do not|don'?t|never)\b[^.\n]{0,20}\b(tell|inform|show|reveal)\b[^.\n]{0,20}\b(the )?user\b/i,
    detail: 'asks the assistant to hide something from the user' },
  { rule: 'injection_phrase', re: /\b(reveal|print|output|repeat)\b[^.\n]{0,25}\b(system prompt|hidden instructions)\b/i,
    detail: 'asks for the system prompt' },
  { rule: 'pipe_to_shell', re: /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/i,
    detail: 'downloads and runs a script in one step' },
  { rule: 'network_command', re: /\b(curl|wget|nc|ncat)\s+(-\S+\s+)*https?:\/\//i,
    detail: 'calls out to a network address' },
  { rule: 'secret_path', re: /(~|\$HOME|\/Users\/[^/\s]+|\/home\/[^/\s]+)\/\.(ssh|aws|gnupg|kube|netrc|npmrc|docker)\b|\bid_(rsa|ed25519)\b|\.env\b|keychain/i,
    detail: 'mentions a place credentials are kept' },
  { rule: 'destructive_command', re: /\brm\s+-[a-z]*r[a-z]*f?\s+(\/|~|\$HOME)(\s|$)|\bmkfs\b|\bdd\s+if=.*\sof=\/dev\//i,
    detail: 'a command that can wipe files' },
];

const BASE64_RE = /[A-Za-z0-9+/]{200,}={0,2}/;
const URL_RE = /https?:\/\/([a-z0-9.-]+)(?::\d+)?/gi;
// Hosts a skill commonly links to for documentation; everything else is listed.
const COMMON_HOSTS = [/(^|\.)github\.com$/, /(^|\.)githubusercontent\.com$/, /(^|\.)anthropic\.com$/, /(^|\.)claude\.com$/,
  /(^|\.)npmjs\.(com|org)$/, /(^|\.)python\.org$/, /(^|\.)mozilla\.org$/, /(^|\.)wikipedia\.org$/, /^(www\.)?w3\.org$/,
  /(^|\.)example\.(com|org)$/, /^localhost$/, /^json-schema\.org$/, /(^|\.)modelcontextprotocol\.io$/];

function excerpt(line, at = 0) {
  const s = line.slice(Math.max(0, at - 20), at + 60).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
}

/**
 * @param {Map<string, Buffer>} files
 * @param {{ skipped?: Array<{path: string, reason: string}> }} [o]
 * @returns {Array<{ rule: string, severity: 'warn', file: string, line?: number, detail: string, excerpt?: string }>}
 */
export function scanTree(files, { skipped = [] } = {}) {
  const findings = [];
  const add = (f) => { if (findings.length < MAX_FINDINGS) findings.push({ severity: 'warn', ...f }); };
  for (const s of skipped) {
    if (s.reason === 'link') add({ rule: 'link_skipped', file: s.path, detail: 'a symbolic or hard link was not installed' });
    else if (s.reason === 'too_large') add({ rule: 'large_file_skipped', file: s.path, detail: 'a file over 2 MB was not installed' });
  }
  for (const [file, buf] of files) {
    if (findings.length >= MAX_FINDINGS) break;
    const slice = buf.subarray(0, MAX_SCAN_BYTES);
    if (slice.includes(0)) {
      if (!/\.(png|jpe?g|gif|webp|ico|pdf|woff2?|ttf|zip|gz)$/i.test(file)) add({ rule: 'binary_file', file, detail: 'a binary file the scan cannot read' });
      continue;
    }
    if (!TEXT_EXT.test(file) && !/(^|\/)(SKILL|README|LICENSE)[^/]*$/i.test(file) && !file.startsWith('bin/')) continue;
    const text = slice.toString('utf8');
    const lines = text.split('\n');
    const hosts = new Set();
    lines.forEach((line, i) => {
      if (line.length > 4000) { add({ rule: 'long_line', file, line: i + 1, detail: 'a very long line (possible hidden payload)' }); return; }
      if (HIDDEN_RE.test(line)) add({ rule: 'hidden_characters', file, line: i + 1, detail: 'contains zero-width or bidirectional control characters' });
      for (const r of RULES) {
        const m = r.re.exec(line);
        if (m) add({ rule: r.rule, file, line: i + 1, detail: r.detail, excerpt: excerpt(line, m.index) });
      }
      const b = BASE64_RE.exec(line);
      if (b) add({ rule: 'base64_blob', file, line: i + 1, detail: 'a long base64-looking blob', excerpt: excerpt(line, b.index) });
      for (const u of line.matchAll(URL_RE)) {
        const host = u[1].toLowerCase().replace(/\.$/, '');
        if (!COMMON_HOSTS.some((re) => re.test(host))) hosts.add(host);
      }
    });
    if (hosts.size) add({ rule: 'external_host', file, detail: `links to ${[...hosts].slice(0, 5).join(', ')}${hosts.size > 5 ? ` and ${hosts.size - 5} more` : ''}` });
  }
  return findings;
}

/** Counts by rule, for the summary a list view shows. */
export function summarizeFindings(findings) {
  const byRule = {};
  for (const f of findings) byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;
  return { count: findings.length, byRule };
}
