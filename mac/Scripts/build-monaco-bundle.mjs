#!/usr/bin/env node
// Vendors a MINIMAL Monaco Editor build into
// Sources/LlmIdeMac/Resources/monaco/ — the loader + core editor, plus
// Monarch tokenizers (basic-languages/) for ONLY the languages this repo
// actually uses. Deliberately skips monaco-editor's `language/` folder
// entirely (the heavier JSON/TypeScript/CSS/HTML "language service" mode
// files, including their web-worker IntelliSense backends) — this app wants
// syntax highlighting, not IntelliSense, and the basic-languages Monarch
// tokenizers cover every one of these languages on their own.
//
// Usage: cd mac && npm install monaco-editor@<version> --no-save && node Scripts/build-monaco-bundle.mjs

import { existsSync, mkdirSync, cpSync, rmSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const macRoot = path.resolve(__dirname, '..');
const monacoPkg = path.join(macRoot, 'node_modules', 'monaco-editor');
const srcVs = path.join(monacoPkg, 'min', 'vs');
const outDir = path.join(macRoot, 'Sources', 'LlmIdeMac', 'Resources', 'monaco');
const outVs = path.join(outDir, 'vs');
const monacoSrc = path.join(macRoot, 'Sources', 'LlmIdeMac', 'Resources', 'monaco-src');

// The languages this repo's files actually use (verified against
// `git ls-files` extension counts in the design doc) — see design §4.
// `json` is deliberately excluded: monaco-editor has no basic-languages
// Monarch tokenizer for it (JSON highlighting only exists in the
// language/ "IntelliSense mode" folder we skip above) — confirmed against
// the actual package, not a naming mismatch. JSON files still open fine,
// just as plain unhighlighted text.
const LANGUAGES = [
  'markdown', 'javascript', 'typescript', 'sql',
  'python', 'shell', 'yaml', 'html', 'css', 'swift',
];

function must(condition, message) {
  if (!condition) {
    console.error(`build-monaco-bundle: ${message}`);
    process.exit(1);
  }
}

must(existsSync(srcVs),
  `${srcVs} not found — run "npm install monaco-editor --no-save" in mac/ first`);

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outVs, { recursive: true });

// Core: loader + editor engine (works as a plain-text editor with zero
// language files; language files below are purely additive highlighting).
cpSync(path.join(srcVs, 'loader.js'), path.join(outVs, 'loader.js'));
cpSync(path.join(srcVs, 'base'), path.join(outVs, 'base'), { recursive: true });

// Editor engine, minus non-default NLS locale packs: bootstrap.js never
// configures `vs/nls.availableLanguages`, so only the unsuffixed
// editor.main.nls.js (English) is ever requested — the ~10 per-locale
// editor.main.nls.<lang>.js files (ru/ja/ko/zh-*/fr/it/es/de, ~1.8MB) are
// dead weight in an offline, single-locale-UI bundle.
const srcEditor = path.join(srcVs, 'editor');
const outEditor = path.join(outVs, 'editor');
mkdirSync(outEditor, { recursive: true });
for (const entry of readdirSync(srcEditor)) {
  if (/^editor\.main\.nls\.[a-z-]+\.js$/.test(entry)) continue;
  cpSync(path.join(srcEditor, entry), path.join(outEditor, entry), { recursive: true });
}

// Per-language Monarch tokenizers only — never the `language/` folder.
const basicLanguagesDir = path.join(srcVs, 'basic-languages');
mkdirSync(path.join(outVs, 'basic-languages'), { recursive: true });
for (const lang of LANGUAGES) {
  const from = path.join(basicLanguagesDir, lang);
  must(existsSync(from),
    `expected basic-languages/${lang} in the installed monaco-editor package but it's missing — ` +
    `check the language id against monaco-editor's actual basic-languages/ directory listing`);
  cpSync(from, path.join(outVs, 'basic-languages', lang), { recursive: true });
}

// The hand-authored shell + bridge script, copied verbatim (never
// minified/regenerated) so they stay readable and diffable in source form.
cpSync(path.join(monacoSrc, 'index.html'), path.join(outDir, 'index.html'));
cpSync(path.join(monacoSrc, 'bootstrap.js'), path.join(outDir, 'bootstrap.js'));

console.log(`build-monaco-bundle: wrote ${outDir}`);
