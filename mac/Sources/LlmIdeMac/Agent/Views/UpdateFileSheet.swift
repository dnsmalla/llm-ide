import SwiftUI

/// Cursor-style editable confirmation sheet for the `update-file`
/// write tool. The agent proposes new content for an attached file;
/// this sheet renders a unified diff against the current file content
/// and lets the user tweak the proposal before applying.
///
/// The sheet itself never writes to disk — the owner does that on
/// Apply via `onConfirm`. This keeps file I/O in the panel where the
/// in-memory attachment list also lives, so a successful write can
/// refresh that list atomically.
struct UpdateFileSheet: View {
    @Environment(\.dismiss) private var dismiss

    enum ConfirmResult {
        case success
        case failure(String)
    }

    /// The current on-disk content of the file the agent is proposing
    /// to edit (taken from the matching attachment). Used as the LHS
    /// of the diff.
    let originalContent: String
    /// Display path — same string the attachment chip shows. Surfaced
    /// verbatim so the user recognises which file they're editing.
    let displayPath: String
    /// Absolute path that the panel will write to on Apply.
    let absolutePath: String
    let onConfirm: (String) async -> ConfirmResult

    @State private var proposedContent: String
    @State private var submitting: Bool = false
    @State private var errorMessage: String?

    init(initialArgs args: PendingTool.UpdateFileArgs,
         originalContent: String,
         displayPath: String,
         onConfirm: @escaping (String) async -> ConfirmResult) {
        self.originalContent = originalContent
        self.displayPath = displayPath
        self.absolutePath = args.path
        self.onConfirm = onConfirm
        _proposedContent = State(initialValue: args.content)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            header
            Divider()

            diffPane

            VStack(alignment: .leading, spacing: 6) {
                Text("Proposed content (editable)")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.secondary)
                TextEditor(text: $proposedContent)
                    .font(.system(size: 11, design: .monospaced))
                    .frame(minHeight: 140, maxHeight: 240)
                    .overlay(RoundedRectangle(cornerRadius: 4)
                                .stroke(Color.secondary.opacity(0.3)))
            }

            if let err = errorMessage {
                Text(err)
                    .font(.system(size: 12))
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack {
                Text(changeSummary)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(.secondary)
                Spacer()
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                    .disabled(submitting)
                Button("Apply") { submit() }
                    .keyboardShortcut(.defaultAction)
                    .buttonStyle(.borderedProminent)
                    .disabled(submitting || proposedContent == originalContent)
            }
        }
        .padding(20)
        .frame(minWidth: 720, minHeight: 560)
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Update file").font(.title3.bold())
            Text(displayPath)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
        }
    }

    // MARK: - Diff

    /// One row of the unified diff with both side line numbers, like
    /// VSCode/Cursor. `oldNum`/`newNum` are nil when the line doesn't
    /// exist on that side (removed-only / added-only respectively).
    private struct DiffRow: Identifiable {
        enum Kind { case equal, insert, remove }
        let id = UUID()
        let kind: Kind
        let oldNum: Int?
        let newNum: Int?
        let text: String
    }

    /// Build a line-level diff between `originalContent` and the
    /// currently-edited `proposedContent`. Foundation's
    /// `CollectionDifference` gives us LCS-quality offsets cheaply.
    private var diffRows: [DiffRow] {
        let oldLines = originalContent.components(separatedBy: "\n")
        let newLines = proposedContent.components(separatedBy: "\n")

        let diff = newLines.difference(from: oldLines)
        var removedFromOld = Set<Int>()
        var insertedInNew = Set<Int>()
        for change in diff {
            switch change {
            case .remove(let off, _, _): removedFromOld.insert(off)
            case .insert(let off, _, _): insertedInNew.insert(off)
            }
        }

        var rows: [DiffRow] = []
        var i = 0
        var j = 0
        while i < oldLines.count || j < newLines.count {
            let iRemoved = i < oldLines.count && removedFromOld.contains(i)
            let jInserted = j < newLines.count && insertedInNew.contains(j)
            if iRemoved {
                rows.append(.init(kind: .remove, oldNum: i + 1, newNum: nil, text: oldLines[i]))
                i += 1
            } else if jInserted {
                rows.append(.init(kind: .insert, oldNum: nil, newNum: j + 1, text: newLines[j]))
                j += 1
            } else if i < oldLines.count && j < newLines.count {
                rows.append(.init(kind: .equal, oldNum: i + 1, newNum: j + 1, text: newLines[j]))
                i += 1
                j += 1
            } else if j < newLines.count {
                rows.append(.init(kind: .insert, oldNum: nil, newNum: j + 1, text: newLines[j]))
                j += 1
            } else if i < oldLines.count {
                rows.append(.init(kind: .remove, oldNum: i + 1, newNum: nil, text: oldLines[i]))
                i += 1
            }
        }
        return rows
    }

    @ViewBuilder
    private var diffPane: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Diff vs current file")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.secondary)
            // Outer vertical scroll — rows.
            // Inner horizontal scroll — long lines don't wrap, they
            // scroll right (the VSCode/Cursor pattern).
            ScrollView(.vertical) {
                ScrollView(.horizontal, showsIndicators: true) {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(diffRows) { row in
                            diffRowView(row)
                        }
                    }
                }
            }
            .frame(minHeight: 240, maxHeight: 380)
            .background(Color(nsColor: .textBackgroundColor))
            .overlay(RoundedRectangle(cornerRadius: 4)
                        .stroke(Color.secondary.opacity(0.3)))
        }
    }

    /// Width reserved for each line-number gutter. Roughly 4 digits +
    /// padding at 11pt monospaced — comfortably fits files up to 9999
    /// lines without jitter.
    private let lineNumWidth: CGFloat = 38

    @ViewBuilder
    private func diffRowView(_ row: DiffRow) -> some View {
        let (sign, bg): (String, Color) = {
            switch row.kind {
            case .insert: return ("+", Color.green.opacity(0.16))
            case .remove: return ("−", Color.red.opacity(0.16))
            case .equal:  return (" ", Color.clear)
            }
        }()
        let fg: Color = row.kind == .equal ? .secondary : .primary

        HStack(spacing: 0) {
            // Old-side gutter
            Text(row.oldNum.map(String.init) ?? "")
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(Color.secondary.opacity(0.7))
                .frame(width: lineNumWidth, alignment: .trailing)
                .padding(.trailing, 6)
            // New-side gutter
            Text(row.newNum.map(String.init) ?? "")
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(Color.secondary.opacity(0.7))
                .frame(width: lineNumWidth, alignment: .trailing)
                .padding(.trailing, 8)
            // Sign column. The raw "+"/"−" glyphs read as punctuation
            // to VoiceOver, so we replace them with descriptive labels
            // (and hide the column entirely for equal/context rows).
            Text(sign)
                .font(.system(size: 11, weight: .semibold, design: .monospaced))
                .foregroundStyle(fg.opacity(0.7))
                .frame(width: 14, alignment: .center)
                .accessibilityLabel({
                    switch row.kind {
                    case .insert: return "Added line"
                    case .remove: return "Removed line"
                    case .equal:  return ""
                    }
                }())
                .accessibilityHidden(row.kind == .equal)
            // Code text — fixedSize horizontally so long lines extend
            // beyond the viewport and the horizontal scroll handles
            // them, no wrapping mid-token.
            Text(row.text.isEmpty ? " " : row.text)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(fg)
                .fixedSize(horizontal: true, vertical: false)
                .padding(.leading, 2)
                .padding(.trailing, 12)
            Spacer(minLength: 0)
        }
        .padding(.vertical, 1)
        .background(bg)
    }

    /// "+12 −3" summary chip. Drives nothing functional but gives the
    /// user a quick at-a-glance read of the size of the change.
    private var changeSummary: String {
        let rows = diffRows
        let added = rows.filter { $0.kind == .insert }.count
        let removed = rows.filter { $0.kind == .remove }.count
        return "+\(added) −\(removed) lines"
    }

    private func submit() {
        let toApply = proposedContent
        Task {
            submitting = true
            defer { submitting = false }
            errorMessage = nil
            let outcome = await onConfirm(toApply)
            switch outcome {
            case .success:
                dismiss()
            case .failure(let msg):
                errorMessage = msg
            }
        }
    }
}
