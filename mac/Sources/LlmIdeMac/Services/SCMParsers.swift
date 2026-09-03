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
            // Rename: "old -> new" — keep the new path.
            if let r = pathPart.range(of: " -> ") {
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
            if x != " " { out.append(FileChange(path: pathPart, status: status(for: x), staged: true)) }
            if y != " " { out.append(FileChange(path: pathPart, status: status(for: y), staged: false)) }
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

        for raw in text.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline) {
            let line = String(raw)
            if line.hasPrefix("@@") {
                if let c = current { hunks.append(c) }
                (oldLine, newLine) = Self.hunkStarts(line)
                current = DiffHunk(header: line, rows: [])
                continue
            }
            // Skip file headers / metadata.
            if current == nil { continue }
            if line.hasPrefix("diff --git") || line.hasPrefix("index ")
                || line.hasPrefix("--- ") || line.hasPrefix("+++ ")
                || line.hasPrefix("\\") { continue }

            guard let first = line.first else {
                // blank line within a hunk = an empty context line
                current?.rows.append(DiffRow(kind: .context, oldLine: oldLine, newLine: newLine, text: ""))
                oldLine += 1; newLine += 1
                continue
            }
            let body = String(line.dropFirst())
            switch first {
            case "+":
                current?.rows.append(DiffRow(kind: .insert, oldLine: nil, newLine: newLine, text: body))
                newLine += 1
            case "-":
                current?.rows.append(DiffRow(kind: .delete, oldLine: oldLine, newLine: nil, text: body))
                oldLine += 1
            default: // context (leading space)
                current?.rows.append(DiffRow(kind: .context, oldLine: oldLine, newLine: newLine, text: body))
                oldLine += 1; newLine += 1
            }
        }
        if let c = current { hunks.append(c) }
        return hunks
    }

    /// Parse "@@ -a,b +c,d @@" → (a, c).
    private static func hunkStarts(_ header: String) -> (Int, Int) {
        // parts[0]=="@@", parts[1]=="-a[,b]", parts[2]=="+c[,d]", parts[3...]=="@@" + optional context
        // Only read the two fixed-position range tokens; the trailing function-context text
        // (e.g. "func add() -> Int {") can contain "-" / "+" tokens that would otherwise
        // clobber oldStart / newStart when iterating over all parts.
        let parts = header.split(separator: " ")
        guard parts.count >= 3 else { return (0, 0) }
        let old = Int(parts[1].dropFirst().split(separator: ",").first ?? "0") ?? 0
        let new = Int(parts[2].dropFirst().split(separator: ",").first ?? "0") ?? 0
        return (old, new)
    }
}
