---
title: Full Search panel (find + replace, VS Code/Cursor parity)
status: draft
date: 2026-06-16
---

# Full Search panel — design

## Goal

Bring the Search section to VS Code/Cursor parity: search options
(case/word/regex), files-to-include/exclude globs, rich grouped results
(per-file count badge, expand/collapse, highlighted matches, "N results in M
files", open-at-line, dismiss), and find-and-replace (one / in-file / all,
preserve-case).

## Engine — `SearchService`

### Models
```
struct SearchOptions { var caseSensitive=false; var wholeWord=false; var regex=false }
struct Match { let charRange: Range<Int>     // char offsets within `lineText`
               let fileIndex: Int }           // 0-based occurrence across the whole file
struct LineMatch { let line: Int; let lineText: String; let matches: [Match] }
struct FileMatch { let url, displayPath, nameMatched, lineMatches: [LineMatch]; id=url.path }
struct SearchResults { let files: [FileMatch]; let totalMatches: Int; let fileCount: Int }
```

### Matching
- Build ONE `NSRegularExpression` from (query, options): plain → escaped literal;
  wholeWord → `\b` + escaped + `\b`; regex → query verbatim. `caseSensitive`
  false → `.caseInsensitive`. Invalid regex → no results + an `error` flag the
  UI can show.
- Per file (text, ≤1 MB, non-binary, noise-dir filtered via `IgnoreList`):
  enumerate regex matches over the full content; map each to (line number,
  char range within that line, file-wide occurrence index). Group by line.
- Honor **include/exclude globs** (comma-separated) against the repo-relative
  path before scanning a file. Glob support: `*`, `**`, `?`, and dir prefixes
  like `app/job/logic/` (treated as `app/job/logic/**`). A small glob→regex
  helper; empty include = all files.
- Caps: ≤1000 total matches, off-main `Task.detached`, cancellable (new query
  supersedes). Return `SearchResults` with counts.

### Replace (destructive — writes files)
- `replaceOne(file:, fileIndex:, with:, options:, preserveCase:)` — re-match the
  file, replace the `fileIndex`-th occurrence, write.
- `replaceInFile(file:, with:, options:, preserveCase:)` — replace all matches in
  one file, write.
- `replaceAll(in results:, with:, options:, preserveCase:)` — replace across all
  matched files, write each. **Confirmation required** (count of files/matches).
- Replacement template: for regex mode, NSRegularExpression templates (`$1` etc.)
  pass through. **Preserve-case (`AB`)**: when on and the match is non-regex,
  adapt the replacement to the matched text's case (ALL-CAPS→upper,
  Capitalized→capitalized, lower→lower).
- After any replace → re-run the current search to refresh results.

## UI — `SearchView`

- **Find row:** query `TextField` + three toggle buttons `Aa` (caseSensitive),
  `ab` (wholeWord), `.*` (regex), highlighted when active. A regex-error tint
  when the pattern is invalid.
- **Replace row:** replace `TextField` + `AB` (preserve-case) toggle +
  **Replace All** button (confirmed). Collapsible (a chevron toggles the replace
  row, like Cursor).
- **files to include / files to exclude:** two `TextField`s (glob, comma-sep).
- **Results header:** "N results in M files" + (re-run is automatic).
- **Results list:** per-file `DisclosureGroup` — header = file icon +
  `displayPath` + **count badge**; expanded shows each `LineMatch` row with the
  line text and the matched substring(s) **highlighted** (AttributedString or
  segment background). Row hover → **Replace** (single, when a replacement is
  set) + **× dismiss** (removes that result from the view only). Click a row →
  open the file in a tab **scrolled near the line** (best-effort; at minimum
  open the file).
- Debounced (~250 ms) re-search on change of query / options / include /
  exclude. Root = `WorkspaceRoot.resolve` (same as today). Empty/no-results/
  invalid-regex states.

## Components affected / created

- Modify: `Services/SearchService.swift` (options, globs, ranges+counts,
  replace ops), `Views/Search/SearchView.swift` (the full panel).
- Create: `Services/GlobMatch.swift` (glob→regex helper, pure) + test;
  extend `Tests/.../SearchServiceTests.swift` (options + ranges + glob +
  replace-string transforms).

## Data flow

1. query/options/include/exclude change → debounce → `search(...)` →
   `SearchResults` → grouped list with counts + highlighted ranges.
2. Click result → open file tab (scroll-to-line best effort).
3. Replace one/in-file/all → write file(s) → re-search → results refresh.

## Error handling

- Invalid regex → no results + an inline "invalid pattern" tint; never crash.
- Replace failures (write/permission) → inline error; partial replace-all
  reports how many files changed.
- Replace-all → destructive confirmation naming files+matches count. Repo is
  git-tracked, so changes are recoverable via Source Control.
- Unreadable/binary/oversized files skipped (as today).

## Testing & verification

- **Pure/unit:** `GlobMatch` (`*`/`**`/`?`/dir-prefix → match/no-match);
  the regex builder (plain/word/regex + case) producing expected matches +
  ranges on a fixture; the preserve-case transform (FOO/Foo/foo). XCTest
  doesn't run here → compile + contract.
- **Runtime (real dir):** search the repo with options + include/exclude and
  confirm counts/ranges; do a replace-in-file on a temp file and confirm the
  rewrite; build + launch smoke. GUI clicks login-gated.

## Risks

- **Replace is destructive** — gate replace-all behind confirmation; rely on the
  repo being git-tracked for recovery; re-search after to show the new state.
- **Char-offset vs String.Index** — be careful mapping NSRegularExpression
  (UTF-16) ranges to Swift String character offsets for highlighting; use a
  consistent representation (NSString/UTF-16 throughout the line, or convert
  once). Cover with a multibyte (Japanese) fixture — the screenshot搜索 is
  Japanese (出力調整禁止), so multibyte correctness matters.
- **Regex perf** on large repos — keep the 1 MB/file + 1000-match caps,
  off-main, cancellable.
