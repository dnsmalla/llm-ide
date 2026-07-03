// Phase 6 — guardrail rule engine.  Deterministic checks that run on
// every artifact before it can be approved for execution.  Each rule
// returns one of three severities:
//
//   blocking — submission is rejected outright; reviewer cannot approve
//              until the rule passes.
//   warning  — surfaced to the reviewer in red but doesn't block.
//   info     — surfaced as context (e.g. "this would create N tickets").
//
// We keep this module pure (no DB, no network) so it can be unit-tested
// and reused by the LLM eval suite later.

// redactSecrets is pure (string in, string out — no DB/network), so it
// doesn't violate the constraint above. It's used to scrub the raw matched
// value out of secret findings before they're persisted/returned — see
// findMatches(..., { redact: true }) below.
import { redactSecrets } from '../core/redact-secrets.mjs';

// Exported so scan.mjs can import the same list instead of maintaining
// a parallel copy that could silently drift out of sync.
export const SECRET_PATTERNS = [
  // Conservative — match common token shapes anywhere in the body.
  // gh[oprsu]_ covers all GitHub token classes (ghp_ PAT, gho_ OAuth,
  // ghu_ user-to-server, ghs_ server-to-server, ghr_ refresh) — kept in
  // sync with core/redact-secrets.mjs (the redaction sink for the same shapes).
  { name: 'GitHub token',  re: /\b(gh[oprsu]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{82})\b/ },
  // GitLab tokens (glpat- PAT, glrt- runner, glcbt- CI job, gldt- deploy, …).
  // The project's own tracker is GitLab-hosted, so a leaked PAT here is a real
  // risk; this list must match core/redact-secrets.mjs's GitLab shape.
  { name: 'GitLab token',  re: /\bgl(?:pat|oas|rt|cbt|ptt|ft|imt|agent|soat|dt|ffct)-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Slack token',   re: /\bxox[abp]-[A-Za-z0-9-]{10,}/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z\-_]{35}\b/ },
  // Anthropic API key — checked BEFORE the generic OpenAI-style "sk-" rule
  // below so an sk-ant- key is reported under its own name rather than
  // matching the more general pattern first.
  { name: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9-]{10,}\b/ },
  // OpenAI project-scoped key — checked before the generic sk- rule. The
  // generic rule can't catch it: sk-proj- contains a hyphen after "proj",
  // which breaks the generic rule's [A-Za-z0-9]{20,} body match.
  { name: 'OpenAI project key', re: /\bsk-proj-[A-Za-z0-9_-]{20,}\b/ },
  // Generic "sk-" secret key (OpenAI classic / other providers using the
  // same shape). Excludes sk-ant- and sk-proj- via negative lookahead so it
  // doesn't double-report a key already caught by the rules above.
  { name: 'Generic sk- API key', re: /\bsk-(?!ant-|proj-)[A-Za-z0-9]{20,}\b/ },
  // Separator limited to 1-3 chars to prevent catastrophic backtracking
  // on inputs like 'api_key:::::::::::::::::' (unbounded '+' was exploitable).
  { name: 'Generic API key', re: /\b(api[_-]?key|secret[_-]?key|access[_-]?token)["'\s:=]{1,3}[A-Za-z0-9_\-]{16,}\b/i },
  { name: 'Private key',    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'Bearer token',   re: /Bearer\s+[A-Za-z0-9._\-]{20,}\b/i },
];

const PII_PATTERNS = [
  { name: 'Email address',      re: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i },
  // Card numbers with explicit group separators (spaces or hyphens),
  // e.g. "4111 1111 1111 1111" or "4111-1111-1111-1111".  Pure digit
  // strings like timestamps/IDs (14–19 contiguous digits) still have a
  // high false-positive rate and are intentionally excluded — the
  // separator-based pattern is specific enough for a guardrail warning.
  { name: 'Credit card number', re: /\b(?:\d{4}[- ]){3}\d{3,4}\b/ },
  { name: 'US SSN',             re: /\b\d{3}-\d{2}-\d{4}\b/ },
  // JP My Number — 12-digit individual number (個人番号 / マイナンバー).
  // A bare \b\d{12}\b has a very high false-positive rate: timestamps,
  // phone numbers, order IDs, and many other numeric identifiers are also
  // 12 digits.  We require a nearby context keyword (within 60 chars) to
  // reduce noise.  The lookahead/lookbehind covers text that precedes or
  // follows the number, case-insensitively in ASCII, and also matches the
  // two common Japanese spellings used in meeting transcripts and docs.
  { name: 'JP My Number',
    re: /(?:マイナンバー|個人番号|my\s*number|myna\s*number|mynumber)[\s\S]{0,60}\b\d{12}\b|\b\d{12}\b[\s\S]{0,60}(?:マイナンバー|個人番号|my\s*number|myna\s*number|mynumber)/i },
  { name: 'Phone (intl)',       re: /\+\d[\d\-\s]{8,}\b/ },
];

const DESTRUCTIVE_PATTERNS = [
  { name: 'rm -rf',         re: /\brm\s+-rf\b/ },
  { name: 'DROP TABLE',     re: /\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i },
  { name: 'TRUNCATE',       re: /\bTRUNCATE\s+TABLE\b/i },
  { name: 'force push',     re: /git\s+push\s+(?:.*\s)?(--force|-f)\b/i },
  { name: 'shell exec',     re: /\beval\s*\(|new\s+Function\s*\(|child_process\.exec\b/i },
];

// `redact`: when true (secret patterns only — never PII/destructive, where
// the reviewer needs to see the actual matched text to judge the finding),
// the matched token itself is scrubbed out of the returned snippet before
// it's returned. Findings from this function get persisted verbatim into
// the review_items.guardrails column and echoed back in API responses
// (kb/routes/review.mjs submit/approve), so a raw secret value here would
// leak into the DB, logs, and any client that reads the review item —
// exactly the credential-exposure the guardrail is supposed to prevent.
function findMatches(text, patterns, { redact = false } = {}) {
  if (typeof text !== 'string' || !text) return [];
  // Attacker can split a secret across two lines (intentionally or via
  // hand-wrapped LLM output) so that `\b` boundaries fail to bridge the
  // newline.  Match against both the raw text (for snippet context) AND
  // a whitespace-collapsed variant — if the variant matches we report
  // the hit even when the raw text wouldn't.  The snippet we surface is
  // still drawn from the raw text so the reviewer sees the real shape.
  // We match against three representations to defeat common evasion tactics:
  //
  //  wsCollapsed  — whitespace stripped: catches line-wrapped secrets where
  //                 a newline breaks the token so \b boundaries fail.
  //
  //  zwCollapsed  — zero-width chars stripped only (U+200B ZWSP, U+200C ZWNJ,
  //                 U+200D ZWJ, U+2060 word-joiner, U+FEFF BOM/ZWNBSP).
  //                 \s does NOT match these in JS, so they let an attacker
  //                 embed an invisible separator inside a token to defeat the
  //                 whitespace collapse.  Stripping just the zero-width chars
  //                 preserves surrounding spaces, keeping \b word-boundaries
  //                 intact for the secret pattern.  The runtime itself inserts
  //                 U+200D for fence redaction, making this evasion realistic.
  //
  // The snippet we surface is always drawn from the raw text so the reviewer
  // sees the real shape (modulo redaction, when requested).
  const wsCollapsed = text.replace(/\s+/g, '');
  const zwCollapsed = text.replace(/[​‌‍⁠﻿]+/g, '');
  const hits = [];
  for (const { name, re } of patterns) {
    let m = text.match(re);
    if (!m) {
      const m2 = wsCollapsed.match(re) || zwCollapsed.match(re);
      if (m2) {
        // No precise index into the raw text — surface the first 60
        // chars of the raw text after the match position in `collapsed`
        // as best-effort context.
        let snippet = `(line-wrapped) ${text.slice(0, 60).replace(/\s+/g, ' ')}…`;
        if (redact) snippet = redactSnippet(snippet, re);
        hits.push({ name, snippet });
      }
      continue;
    }
    const start = Math.max(0, (m.index || 0) - 20);
    const end   = Math.min(text.length, (m.index || 0) + m[0].length + 20);
    let snippet = text.slice(start, end).replace(/\s+/g, ' ');
    if (redact) snippet = redactSnippet(snippet, re);
    hits.push({ name, snippet });
  }
  return hits;
}

// Redact a snippet that is about to be persisted/returned as a secret
// finding. Two passes:
//   1. Re-run the SAME rule regex that produced this finding against the
//      snippet and blank out its own match — this guarantees the exact
//      token that triggered the finding never survives, even for patterns
//      (e.g. "Generic API key": `api_key["'\s:=]{1,3}[A-Za-z0-9_-]{16,}`)
//      that redactSecrets()'s separate, differently-scoped pattern set
//      doesn't recognize.
//   2. Run redactSecrets() as a second pass to catch any *other*
//      recognizable credential shape sitting in the 20-char context window
//      around the primary match (e.g. a Bearer token adjacent to a
//      generic-API-key hit).
function redactSnippet(snippet, re) {
  // Rebuild a global version of the rule's own regex so `.replace` swaps
  // every occurrence, not just the first — a 'g' flag on the shared rule
  // objects would mutate `.lastIndex` across calls (they're reused per
  // findMatches invocation), so we construct a fresh RegExp here instead.
  const globalRe = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  const scrubbed = snippet.replace(globalRe, '[REDACTED]');
  return redactSecrets(scrubbed);
}

function check(severity, ruleId, message, details) {
  return { ruleId, severity, message, details };
}

// --- Dispatch artifacts ---------------------------------------------------

function checkDispatch(payload) {
  const findings = [];
  const target = payload?.target;
  if (!['github', 'backlog', 'linear'].includes(target)) {
    findings.push(check('blocking', 'dispatch.target',
      'Target must be github, backlog, or linear (preview never reaches review).'));
  }

  const items = Array.isArray(payload?.items) ? payload.items : [];
  if (items.length === 0) {
    findings.push(check('blocking', 'dispatch.empty', 'No tasks to dispatch.'));
  }
  if (items.length > 50) {
    findings.push(check('warning', 'dispatch.bulk',
      `Bulk dispatch of ${items.length} tickets — confirm the target tracker can handle this.`));
  }

  for (const it of items) {
    const titleSecrets = findMatches(it?.title || '', SECRET_PATTERNS, { redact: true });
    const bodySecrets  = findMatches(it?.body  || '', SECRET_PATTERNS, { redact: true });
    if (titleSecrets.length || bodySecrets.length) {
      findings.push(check('blocking', 'dispatch.secret',
        `Possible secret in task "${it?.title?.slice(0, 60) || '(untitled)'}".`,
        [...titleSecrets, ...bodySecrets]));
    }
    const titlePii = findMatches(it?.title || '', PII_PATTERNS);
    if (titlePii.length) {
      findings.push(check('warning', 'dispatch.pii',
        `Possible PII in ticket title: ${titlePii.map((h) => h.name).join(', ')}.`));
    }
    if (!it?.title || it.title.length > 250) {
      findings.push(check('warning', 'dispatch.title-length',
        'Title is empty or longer than 250 characters; some trackers will truncate.'));
    }
  }

  // Credentials presence (without leaking them).
  if (target === 'github' && (!payload?.config?.repo || !payload?.config?.token)) {
    findings.push(check('blocking', 'dispatch.creds',
      'GitHub dispatch requires repo and token in config.'));
  }
  if (target === 'backlog' && (!payload?.config?.space || !payload?.config?.projectId
       || !payload?.config?.apiKey || !payload?.config?.issueTypeId)) {
    findings.push(check('blocking', 'dispatch.creds',
      'Backlog dispatch requires space, projectId, apiKey, and issueTypeId.'));
  }
  if (target === 'linear' && (!payload?.config?.teamId || !payload?.config?.apiKey)) {
    findings.push(check('blocking', 'dispatch.creds',
      'Linear dispatch requires teamId and apiKey.'));
  }

  findings.push(check('info', 'dispatch.summary',
    `Will create ${items.length} ${target || 'unknown'} ticket${items.length === 1 ? '' : 's'}.`));

  return findings;
}

// --- Codegen apply artifacts ---------------------------------------------

const ALLOWED_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|md|mdx|txt|rst|json|yml|yaml|toml|ini|cfg|sql|sh|bash|html|css|scss|vue|svelte)$/i;

function checkCodegenApply(payload) {
  const findings = [];
  const allowedRepos = Array.isArray(payload?.allowedRepos) ? payload.allowedRepos : [];
  const repoPath = String(payload?.repoPath || '');
  if (!repoPath) {
    findings.push(check('blocking', 'codegen.repo', 'Repo path is required.'));
  } else if (allowedRepos.length === 0) {
    findings.push(check('blocking', 'codegen.allowlist',
      'No repos are allow-listed for code apply. Add the repo path to the allow-list in Settings → Connectors.'));
  } else {
    const ok = allowedRepos.some((root) => {
      // Path containment: target must equal or be a sub-path of an allowlisted repo.
      const r = String(root).replace(/\/+$/, '');
      return repoPath === r || repoPath.startsWith(r + '/');
    });
    if (!ok) {
      findings.push(check('blocking', 'codegen.allowlist',
        `Repo path is not in the allow-list. Allowed: ${allowedRepos.join(', ')}.`));
    }
  }

  const files = Array.isArray(payload?.files) ? payload.files : [];
  const tests = Array.isArray(payload?.tests) ? payload.tests : [];
  const all = [...files, ...tests];
  if (all.length === 0) {
    findings.push(check('blocking', 'codegen.empty', 'No files or tests to apply.'));
  }
  if (all.length > 12) {
    findings.push(check('warning', 'codegen.bulk',
      `Apply touches ${all.length} files — large changesets are harder to review.`));
  }

  for (const f of all) {
    const path = String(f?.path || '');
    if (!path) {
      findings.push(check('blocking', 'codegen.path', 'File entry is missing a path.'));
      continue;
    }
    if (path.startsWith('/') || path.includes('..') || path.includes('\\')) {
      findings.push(check('blocking', 'codegen.path-escape',
        `Path "${path}" attempts to escape the repo root.`));
    }
    if (!ALLOWED_EXT.test(path)) {
      findings.push(check('warning', 'codegen.path-ext',
        `Path "${path}" has an unfamiliar extension; double-check before approving.`));
    }
    const secrets = findMatches(f?.content || '', SECRET_PATTERNS, { redact: true });
    if (secrets.length) {
      findings.push(check('blocking', 'codegen.secret',
        `Possible secret in "${path}": ${secrets.map((h) => h.name).join(', ')}.`,
        secrets));
    }
    const destructive = findMatches(f?.content || '', DESTRUCTIVE_PATTERNS);
    if (destructive.length) {
      findings.push(check('warning', 'codegen.destructive',
        `Destructive operation in "${path}": ${destructive.map((h) => h.name).join(', ')}.`));
    }
    const sizeKb = (f?.content || '').length / 1024;
    if (sizeKb > 25) {
      findings.push(check('warning', 'codegen.size',
        `"${path}" is ${sizeKb.toFixed(1)} KB; large generated files often need manual review.`));
    }
  }

  findings.push(check('info', 'codegen.summary',
    `Will write ${files.length} file${files.length === 1 ? '' : 's'} + ${tests.length} test${tests.length === 1 ? '' : 's'} under ${repoPath || '(unset)'}.`));

  return findings;
}

// --- Public entry ---------------------------------------------------------

export function runGuardrails(kind, payload) {
  let findings = [];
  if (kind === 'dispatch')        findings = checkDispatch(payload);
  else if (kind === 'codegen-apply') findings = checkCodegenApply(payload);
  else findings = [check('blocking', 'guardrail.kind', `Unknown artifact kind: ${kind}`)];

  const blocking = findings.filter((f) => f.severity === 'blocking');
  const warnings = findings.filter((f) => f.severity === 'warning');
  const info     = findings.filter((f) => f.severity === 'info');
  return {
    passed: blocking.length === 0,
    blocking,
    warnings,
    info,
    findings,
  };
}
