# Full Search Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** VS Code/Cursor Search panel: options (case/word/regex), include/exclude globs, rich grouped results (counts, expand/collapse, highlighted matches, open-at-line, dismiss), and find-and-replace (one/in-file/all, preserve-case).

**Architecture:** One `NSRegularExpression` built from (query, options) drives both find and replace; a pure `GlobMatch` for include/exclude; `SearchService` returns `SearchResults` with per-match char ranges + file-occurrence indices; `SearchView` renders the full panel.

**Tech Stack:** Swift / SwiftUI, NSRegularExpression, swift-testing.

**Environment note:** `swift test` doesn't run here. "Run test" = `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build --build-tests` (dangerouslyDisableSandbox: true). App build = `GIT_CONFIG_GLOBAL=/dev/null swift build`. Verify against a real dir incl. a MULTIBYTE (Japanese) fixture; build + launch smoke for UI.

**CRITICAL — offsets:** NSRegularExpression works in UTF-16. To keep highlight ranges correct for multibyte text (the user searches Japanese `出力調整禁止`), operate each line as `NSString` and store match ranges as **UTF-16 offsets** (`NSRange.location/length`); when highlighting in SwiftUI, build the AttributedString from the NSString/utf16 view (or convert NSRange→Range<String.Index> via `Range(nsRange, in: line)`). Do NOT mix Character offsets with NSRange.

**Build order:** W1 = engine (options/globs/ranges/counts) + tests. W2 = rich find UI. W3 = replace (service + UI + confirm).

---

## Task 1: Search engine — options, globs, ranges, counts

**Files:** `Services/SearchService.swift`; Create `Services/GlobMatch.swift` + `Tests/.../GlobMatchTests.swift`; extend `Tests/.../SearchServiceTests.swift`.

- [ ] **Step 1: GlobMatch (pure) + test.** Create:
```swift
import Foundation
/// Minimal glob → matches a repo-relative path. Supports `*` (any within a
/// segment), `**` (any incl. /), `?`, and a bare dir prefix like
/// `app/job/logic/` (treated as that dir and everything under it).
enum GlobMatch {
    static func matches(path: String, pattern rawPattern: String) -> Bool {
        let pattern = rawPattern.trimmingCharacters(in: .whitespaces)
        guard !pattern.isEmpty else { return true }
        // Bare dir/prefix (no glob metachars, or trailing slash) → prefix match.
        if !pattern.contains(where: { "*?[".contains($0) }) {
            let p = pattern.hasSuffix("/") ? pattern : pattern + "/"
            return path == pattern || path.hasPrefix(p) || path.hasPrefix(pattern + "/")
        }
        let regex = "^" + globToRegex(pattern) + "$"
        return path.range(of: regex, options: .regularExpression) != nil
    }
    /// Any of the comma-separated patterns matches (empty list → true).
    static func matchesAny(path: String, patterns rawList: String) -> Bool {
        let pats = rawList.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        if pats.isEmpty { return true }
        return pats.contains { matches(path: path, pattern: $0) }
    }
    private static func globToRegex(_ glob: String) -> String {
        var r = ""
        var i = glob.startIndex
        while i < glob.endIndex {
            let c = glob[i]
            switch c {
            case "*":
                let next = glob.index(after: i)
                if next < glob.endIndex && glob[next] == "*" { r += ".*"; i = glob.index(after: next); continue }
                r += "[^/]*"
            case "?": r += "[^/]"
            case ".", "(", ")", "+", "|", "^", "$", "{", "}", "\\", "[", "]": r += "\\\(c)"
            default: r.append(c)
            }
            i = glob.index(after: i)
        }
        return r
    }
}
```
Test (`GlobMatchTests`): `app/job/` matches `app/job/x.py` + `app/job/a/b.py`, not `app/other.py`; `*.py` matches `x.py` not `x.txt`; `**/*.swift` matches `a/b/c.swift`; empty pattern matches all.

- [ ] **Step 2: Build test target — expect compile failure.**

- [ ] **Step 3: Rework SearchService.** Replace the existing model + walk with:
```swift
struct SearchOptions: Equatable { var caseSensitive = false; var wholeWord = false; var regex = false }
struct Match: Hashable { let nsRange: NSRange; let fileIndex: Int }   // utf16 range within lineText
struct LineMatch: Hashable { let line: Int; let lineText: String; let matches: [Match] }
struct FileMatch: Identifiable, Hashable { let url: URL; let displayPath: String; let lineMatches: [LineMatch]; var id: String { url.path } }
struct SearchResults: Equatable { var files: [FileMatch] = []; var totalMatches = 0; var fileCount = 0; var invalidPattern = false }
```
- Add `makeRegex(query:options:) -> NSRegularExpression?`: pattern = options.regex ? query : NSRegularExpression.escapedPattern(for: query); if wholeWord wrap `\b…\b`; opts = options.caseSensitive ? [] : [.caseInsensitive]; return `try? NSRegularExpression(pattern:options:)` (nil → invalid → results.invalidPattern=true).
- `search(query:root:options:include:exclude:) async -> SearchResults`: empty query → empty. Build regex (nil → invalidPattern). Off-main walk: for each file (text/≤1MB/non-binary/noise-filtered) whose relative path passes `GlobMatch.matchesAny(path:, include)` AND NOT `GlobMatch.matchesAny(path:, exclude)` (exclude empty → matches none) — split into lines; per line run `regex.matches(in: nsLine, range: NSRange(0..<nsLine.length))`, collect NSRanges; assign a monotonically increasing per-FILE `fileIndex` to every match across the file (in document order). Group matches by line → LineMatch. Accumulate totalMatches; cap 1000. Sort files by displayPath.
- Keep `isBinary`, the 1MB cap, `IgnoreList`.

- [ ] **Step 4: Build (app + tests).**

- [ ] **Step 5: Runtime verify** against the repo: search a literal + a regex + with an include glob; confirm match counts. Also verify a MULTIBYTE case: create a temp file with `出力調整禁止` on a line, confirm the NSRange highlights the right substring (paste the line + the range you'd highlight).

- [ ] **Step 6: Commit.** `git add -A && git commit -m "feat(search): options, include/exclude globs, match ranges + counts"`

---

## Task 2: Rich find UI

**Files:** `Views/Search/SearchView.swift`.

- [ ] **Step 1: State + inputs.** Add `@State` for `options: SearchOptions`, `include: String`, `exclude: String`, `results: SearchResults`, `replaceText: String`, `preserveCase: Bool`, `showReplace: Bool`, `expanded: Set<String>` (file id), `dismissed: Set<String>` (per-match key). Find row: query `TextField` + three toggle Buttons `Aa`/`ab`/`.*` bound to `options.caseSensitive`/`wholeWord`/`regex` (tinted when on). files-to-include / files-to-exclude `TextField`s. Debounced (~250 ms) re-search on change of query/options/include/exclude (cancel prior; cancellable Task; isCancelled guard before assigning results).
- [ ] **Step 2: Results header + list.** Header: `"\(results.totalMatches) results in \(results.fileCount) files"` (or "No results"/"Invalid pattern" tint). List: per-file `DisclosureGroup` keyed in `expanded` (default expanded), header = file icon + displayPath + a count badge (lineMatches' total matches). Each `LineMatch` row: render `lineText` with the matched NSRanges **highlighted** — build an `AttributedString` from the line and set a background/bold on each `Range(nsRange, in: lineText)` segment. Row tap → open the file in a tab (reuse the editor; scroll-to-line is best-effort — at minimum open). Hover → a `×` to add the match key to `dismissed` (filtered out of display).
- [ ] **Step 3: Build + launch smoke.** Build complete!; alive. (Highlighting/expand are visual — confirm no crash + results render; manual visual check noted.)
- [ ] **Step 4: Commit.** `git add -A && git commit -m "feat(search): options toggles, include/exclude, highlighted grouped results"`

---

## Task 3: Replace

**Files:** `Services/SearchService.swift`, `Views/Search/SearchView.swift`; extend SearchServiceTests (preserve-case transform).

- [ ] **Step 1: Service replace ops.**
  - `preserveCaseReplacement(matched:replacement:) -> String` (pure, tested): matched all-upper → replacement.uppercased(); matched Capitalized (first upper, rest not all-upper) → capitalize first; else replacement as-is.
  - `replaceInFile(file:query:options:replacement:preserveCase:) async -> Bool`: read content; build regex; if preserveCase & !regex, iterate matches in REVERSE (so earlier NSRanges stay valid) applying `preserveCaseReplacement` per match; else `regex.stringByReplacingMatches(in:options:range:withTemplate:)` (regex templates pass through). Write file. Return success.
  - `replaceOne(file:fileIndex:query:options:replacement:preserveCase:) async -> Bool`: read; enumerate matches; replace only the `fileIndex`-th (reverse-safe: it's a single splice); write.
  - `replaceAll(in results:query:options:replacement:preserveCase:) async -> Int`: replaceInFile for each file; return count changed.
- [ ] **Step 2: Replace UI.** A chevron toggling `showReplace`. Replace row: replace `TextField` + `AB` (preserveCase) toggle + **Replace All** button → destructive `confirmationDialog` ("Replace N matches in M files?") → `replaceAll(...)` → re-search. Per-row hover **Replace** (single) when `replaceText` non-empty → `replaceOne(file:fileIndex:...)` → re-search. Per-file header hover **Replace All in File** → `replaceInFile` → re-search.
- [ ] **Step 3: Build (app+tests) + runtime verify** replace on a temp file (literal + a multibyte `出力調整禁止`→something, confirm correct bytes written) + preserve-case transform trace.
- [ ] **Step 4: Launch smoke + Commit.** `git add -A && git commit -m "feat(search): find-and-replace (one/in-file/all, preserve-case)"`

---

## Self-review (completed)

- **Spec coverage:** options/globs/ranges/counts (T1), toggles+include/exclude+highlighted-grouped-results+open+dismiss (T2), replace one/in-file/all+preserve-case+confirm (T3). All mapped.
- **Placeholder scan:** GlobMatch + regex builder + preserve-case have complete code/tests; UI steps enumerate concrete controls; the multibyte/UTF-16 handling is called out explicitly.
- **Type consistency:** `SearchOptions`/`Match(nsRange,fileIndex)`/`LineMatch`/`FileMatch`/`SearchResults` (T1) used by SearchView (T2) and the replace ops (T3); `GlobMatch.matchesAny` used in the walk; `makeRegex` shared by find + replace.
- **Confirm-against-codebase flags:** the existing SearchView wiring (debounce/open-tab/EditorTabBar/FileDetailView), `WorkspaceRoot.resolve`, theme/Typography names; that callers of the OLD `search(query:root:)`/`FileMatch.lines` are all updated to the new shape.
