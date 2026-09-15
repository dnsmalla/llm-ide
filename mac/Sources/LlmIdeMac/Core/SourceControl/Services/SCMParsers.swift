import Foundation

enum StatusParser {
    /// Parse `git status --porcelain=v1 --untracked-files=all` output.
    /// Each line is "XY <path>" (rename: "XY <old> -> <new>").
    /// X = index/staged state, Y = worktree/unstaged state.
    static func parse(porcelain: String) -> [FileChange] {
        var out: [FileChange] = []
        for raw in porcelain.split(separator: "\n", omittingEmptySubsequences: true) {
            let line = String(raw)
            guard line.count >= 3 else { continue }
            let chars = Array(line)
            let x = chars[0], y = chars[1]
            var pathPart = String(chars[3...]).trimmingCharacters(in: .whitespaces)
            // Rename/copy: "old -> new". Keep the new path as `pathPart` and,
            // no longer discarding the old one, feed `FileChange.renamedFrom`
            // below so the changes list can show "old → new".
            //
            // GATED ON THE STATUS CODE, because " -> " is a legal substring of
            // a filename and git emits the separator only for R and C. An
            // ungated search split ordinary lines apart:
            // ` M "arrow -> weird.txt"` (verbatim git output — the spaces are
            // why it's quoted) yielded the path `weird.txt"`, which exists
            // nowhere, so the row rendered wrong AND `git add`/`git restore`
            // against it failed. Untracked and conflicted lines were hit too.
            //
            // Each side is quoted INDEPENDENTLY by git (`R  norm.txt ->
            // "plain new.txt"` is real output), so both go through `unquote`
            // separately rather than unquoting the joined string.
            var oldPathPart: String?
            if x == "R" || x == "C" || y == "R" || y == "C",
               let r = pathPart.range(of: " -> ") {
                oldPathPart = unquote(String(pathPart[..<r.lowerBound]))
                pathPart = String(pathPart[r.upperBound...])
            }
            pathPart = unquote(pathPart)

            if x == "?" && y == "?" {
                out.append(FileChange(path: pathPart, status: .untracked, staged: false))
                continue
            }
            if x == "U" || y == "U" {
                out.append(FileChange(path: pathPart, status: .conflicted, staged: false))
                continue
            }
            // `renamedFrom` rides only on the side whose status is actually
            // `.renamed`. A "RM" line means renamed in the index AND
            // modified in the worktree: the staged row is the rename, the
            // unstaged row is an ordinary modification OF THE NEW PATH, and
            // tagging it "old → new" too would claim a rename that side
            // doesn't describe.
            func change(_ code: Character, staged: Bool) -> FileChange {
                let status = status(for: code)
                return FileChange(path: pathPart, status: status, staged: staged,
                                  renamedFrom: status == .renamed ? oldPathPart : nil)
            }
            if x != " " { out.append(change(x, staged: true)) }
            if y != " " { out.append(change(y, staged: false)) }
        }
        return out
    }

    private static func status(for code: Character) -> FileChange.Status {
        switch code {
        case "A": return .added
        case "D": return .deleted
        case "R": return .renamed
        case "M", "T": return .modified
        default:  return .modified
        }
    }

    /// Decode one path from porcelain output.
    ///
    /// git wraps a path in double quotes as soon as it contains a space,
    /// a quote, a backslash, a control character or any byte >= 0x80, and
    /// then C-style-escapes the contents (`quote_c_style`). Stripping only
    /// the quotes is not enough: `設計.txt` arrives as
    /// `"\350\250\255\350\250\210.txt"` under git's default
    /// `core.quotePath`, and returning that literal backslash soup as the
    /// path meant every Japanese-named file showed as octal garbage in the
    /// changes list AND could not be staged, unstaged or discarded — the
    /// path handed back to `git add` did not exist. (Verified against a
    /// real repo; `SourceControlService.commitFiles` dodges the same
    /// problem by asking git for `-z` output instead.)
    ///
    /// Decoding runs over UTF-8 BYTES, not Characters: an octal escape is
    /// one byte and a multi-byte character spans several of them, so the
    /// bytes have to be reassembled before being read back as UTF-8.
    private static func unquote(_ s: String) -> String {
        guard s.hasPrefix("\""), s.hasSuffix("\""), s.count >= 2 else { return s }
        let inner = Array(s.dropFirst().dropLast().utf8)
        var bytes: [UInt8] = []
        bytes.reserveCapacity(inner.count)
        var i = 0
        while i < inner.count {
            let byte = inner[i]
            guard byte == UInt8(ascii: "\\"), i + 1 < inner.count else {
                bytes.append(byte); i += 1; continue
            }
            let next = inner[i + 1]
            // "\nnn" — always exactly three octal digits when git emits it.
            if next >= UInt8(ascii: "0"), next <= UInt8(ascii: "7"), i + 3 < inner.count,
               let value = octalByte(inner[i + 1], inner[i + 2], inner[i + 3]) {
                bytes.append(value); i += 4; continue
            }
            switch next {
            case UInt8(ascii: "a"): bytes.append(0x07)
            case UInt8(ascii: "b"): bytes.append(0x08)
            case UInt8(ascii: "t"): bytes.append(0x09)
            case UInt8(ascii: "n"): bytes.append(0x0A)
            case UInt8(ascii: "v"): bytes.append(0x0B)
            case UInt8(ascii: "f"): bytes.append(0x0C)
            case UInt8(ascii: "r"): bytes.append(0x0D)
            // `\"` and `\\` — and any escape git grows later — are the
            // escaped character itself.
            default: bytes.append(next)
            }
            i += 2
        }
        return String(decoding: bytes, as: UTF8.self)
    }

    /// Three octal digits → one byte, or nil if any of them isn't 0-7.
    private static func octalByte(_ a: UInt8, _ b: UInt8, _ c: UInt8) -> UInt8? {
        var value = 0
        for digit in [a, b, c] {
            guard digit >= UInt8(ascii: "0"), digit <= UInt8(ascii: "7") else { return nil }
            value = value * 8 + Int(digit - UInt8(ascii: "0"))
        }
        return value <= 0xFF ? UInt8(value) : nil
    }
}

enum UnifiedDiffParser {
    /// Parse a git unified diff into hunks of typed rows with line numbers.
    static func parse(_ diff: String) -> [DiffHunk] {
        var hunks: [DiffHunk] = []
        var current: DiffHunk?
        var oldLine = 0, newLine = 0

        // Split on line breaks, dropping the final terminator. Three rules, each
        // guarding a real regression — see SCMParsersTests:
        //
        // 1. **Separate on `isNewline`, never on the "\n" Character.** Swift treats
        //    "\r\n" as ONE extended grapheme cluster, so `split(separator: "\n")`
        //    does not match a CRLF break: a diff from a CRLF checkout (each line's
        //    content ending in \r before the \n terminator) was never split at all
        //    and parsed as one giant row. `isNewline` consumes LF, CRLF and lone CR.
        //
        // 2. **Drop exactly one trailing break, with a single `removeLast()`.** Every
        //    real `git diff` ends in a newline, and the resulting empty final
        //    component became a phantom empty context row under every diff. Counting
        //    characters here is a trap for the same grapheme reason: `removeLast(2)`
        //    on a CRLF ending removes the break AND the character before it, quietly
        //    truncating the last line.
        //
        // 3. **Keep `omittingEmptySubsequences: false`.** A genuinely blank context
        //    line mid-hunk is also an empty component and must survive; only the
        //    terminator's artifact is unwanted, which is why rule 2 handles it
        //    explicitly instead.
        var text = diff
        if let last = text.last, last.isNewline { text.removeLast() }

        // How many old-side / new-side lines the open hunk's "@@" header
        // still promises. This is what separates a FILE HEADER from a ROW
        // whose content merely looks like one — see the skip rules below.
        var remainingOld = 0, remainingNew = 0

        for raw in text.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline) {
            let line = String(raw)

            // "\ No newline at end of file" is hunk METADATA: it sits inside
            // the body but counts toward neither side's budget. Unambiguous,
            // because every real row carries a prefix character, so a row
            // whose content starts with a backslash reads as "-\…" / "+\…".
            if line.hasPrefix("\\") { continue }

            // A bare "@@" line can only be a hunk header, for the same
            // reason — so this stays unconditional even mid-body, and a
            // header whose counts overran its body still ends the hunk here.
            if line.hasPrefix("@@") {
                if let c = current { hunks.append(c) }
                let ranges = Self.hunkRanges(line) ?? (oldStart: 0, oldCount: 0, newStart: 0, newCount: 0)
                (oldLine, newLine) = (ranges.oldStart, ranges.newStart)
                (remainingOld, remainingNew) = (ranges.oldCount, ranges.newCount)
                current = DiffHunk(header: line, rows: [])
                continue
            }
            guard current != nil else { continue }   // preamble, before any hunk

            // **The header-skip rules apply only OUTSIDE the body the "@@"
            // counts declare.** Applying them inside an open hunk dropped any
            // DELETED line whose content began with "-- " (it renders as
            // "--- …") and any INSERTED line beginning with "++" — that is
            // ordinary comment syntax in SQL, Lua, Haskell, Ada, Elm and
            // VHDL, and idiomatic C-family increment. Two things broke:
            // the hunk list claimed "no change" for a line Monaco showed as
            // deleted, and — since P2 rebuilds patches from these rows —
            // `git apply` rejected the synthesized hunk with "corrupt patch"
            // (status 128), because the body no longer matched the counts its
            // own header promised.
            //
            // Once the budget is spent the lenient rules resume, so a
            // multi-file diff still finds the next file's headers, and a
            // hand-written or model-generated diff that UNDERSTATES its
            // counts keeps the tolerance it has always had.
            let insideBody = remainingOld > 0 || remainingNew > 0
            func isFileHeader(_ line: String) -> Bool {
                line.hasPrefix("diff --git") || line.hasPrefix("index ")
                    || line.hasPrefix("--- ") || line.hasPrefix("+++ ")
            }
            if !insideBody, isFileHeader(line) { continue }

            guard let first = line.first else {
                // blank line within a hunk = an empty context line
                current?.rows.append(DiffRow(kind: .context, oldLine: oldLine, newLine: newLine, text: ""))
                oldLine += 1; newLine += 1
                remainingOld -= 1; remainingNew -= 1
                continue
            }
            // A row ALWAYS carries a prefix character, so a line inside the
            // declared body that has none means the header OVERSTATED its
            // counts. Stop trusting them rather than swallowing the next
            // file's metadata as rows.
            if insideBody, first != " ", first != "+", first != "-" {
                remainingOld = 0; remainingNew = 0
                if isFileHeader(line) { continue }
            }
            let body = String(line.dropFirst())
            switch first {
            case "+":
                current?.rows.append(DiffRow(kind: .insert, oldLine: nil, newLine: newLine, text: body))
                newLine += 1; remainingNew -= 1
            case "-":
                current?.rows.append(DiffRow(kind: .delete, oldLine: oldLine, newLine: nil, text: body))
                oldLine += 1; remainingOld -= 1
            default: // context (leading space)
                current?.rows.append(DiffRow(kind: .context, oldLine: oldLine, newLine: newLine, text: body))
                oldLine += 1; newLine += 1
                remainingOld -= 1; remainingNew -= 1
            }
        }
        if let c = current { hunks.append(c) }
        return hunks
    }

    /// Parse `@@ -oldStart[,oldCount] +newStart[,newCount] @@` into its four
    /// numbers, or nil when `header` is not a unified-diff hunk header.
    ///
    /// Only the two fixed-position range tokens are read; the trailing
    /// function-context text (e.g. `func add() -> Int {`) can contain "-" and
    /// "+" tokens that would otherwise clobber the ranges if every part were
    /// scanned.
    ///
    /// A range with no comma is git's shorthand for exactly ONE line
    /// (`@@ -1 +1 @@`), not zero — getting that wrong would make a
    /// single-line hunk look like a whole-file add or delete.
    ///
    /// **Strict on purpose: it returns nil rather than guessing.** The two
    /// callers want opposite things from a header they can't read, and each
    /// picks its own policy at the call site: `parse` falls back to zeros and
    /// keeps collecting rows leniently (its job is to render something), while
    /// `GitTruthStore.assertPatchable` refuses outright (its job is to keep a
    /// patch git would misapply away from the index). A combined diff's
    /// `@@@ -1,3 -1,3 +1,4 @@@` is nil here — its second range is another
    /// old side, not a new one — so a conflicted file renders from line 0
    /// instead of a fabricated 1, and cannot be hunk-staged at all.
    static func hunkRanges(_ header: String)
        -> (oldStart: Int, oldCount: Int, newStart: Int, newCount: Int)? {
        let parts = header.split(separator: " ")
        guard parts.count >= 3, parts[0].hasPrefix("@@"),
              parts[1].hasPrefix("-"), parts[2].hasPrefix("+") else { return nil }
        func range(_ token: Substring) -> (start: Int, count: Int)? {
            let fields = token.dropFirst().split(separator: ",", omittingEmptySubsequences: false)
            guard let first = fields.first, let start = Int(first) else { return nil }
            if fields.count == 1 { return (start, 1) }
            guard fields.count == 2, let count = Int(fields[1]) else { return nil }
            return (start, count)
        }
        guard let old = range(parts[1]), let new = range(parts[2]) else { return nil }
        return (old.start, old.count, new.start, new.count)
    }
}
