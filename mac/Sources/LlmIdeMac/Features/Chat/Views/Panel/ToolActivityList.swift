import SwiftUI

/// The steps the agent took before answering, as compact rows above the
/// reply — the professional form of what used to be raw `<<<TOOL_CALL>>>`
/// JSON streaming into the bubble. A record of what happened; the one
/// interaction is double-clicking a row to reveal that step's tool input
/// and output (the Ctrl+O gesture from Claude Code), when the v2 wire
/// carried them — legacy steps have neither and stay inert.
///
/// Bounded on purpose. A v2 turn can run thirty-odd tools before it says a
/// word, and rendered as a plain stack that pushed the reply — and every
/// card around it — off the screen; the transcript became a wall of "Using
/// Bash". Past `visibleRowCount` the rows move into their own scroller
/// pinned to the newest step, so a long turn costs a fixed amount of
/// transcript height whatever it does. Under that many, the list renders
/// inline exactly as before — a three-step turn should not sprout chrome.
struct ToolActivityList: View {
    let steps: [ChatMessage.ToolStep]

    @EnvironmentObject var theme: ThemeStore
    /// Set by the header's toggle: drop the height cap and show every row
    /// inline. The escape hatch for reading a long run end to end without
    /// fighting a nested scroller.
    @State private var expanded = false
    /// Steps whose detail (tool args + result) is open, toggled per row by
    /// double-click. A set, not a single id: comparing two steps' outputs
    /// side by side is the point of expanding them.
    @State private var expandedStepIds: Set<UUID> = []

    /// Rows shown before the list starts scrolling instead of growing.
    private static let visibleRowCount = 5
    /// Row height (11pt text) + the stack's spacing. Used to derive the
    /// scroller's height rather than measuring, so the cap is exactly N rows
    /// with no half-row peeking out of the bottom.
    private static let rowHeight: CGFloat = 15
    private static let rowSpacing: CGFloat = 3

    private var isScrollable: Bool { steps.count > Self.visibleRowCount }

    /// Exactly N closed rows — only valid while no row's detail is open,
    /// which is why `body` drops the cap entirely in that case.
    private var cappedHeight: CGFloat {
        CGFloat(Self.visibleRowCount) * Self.rowHeight
            + CGFloat(Self.visibleRowCount - 1) * Self.rowSpacing
    }

    var body: some View {
        let content = VStack(alignment: .leading, spacing: 3) {
            if isScrollable { header }
            // An open detail block (~400pt) inside an 87pt scroller is
            // unreadable, and scrollToLast would yank it off screen on the
            // next step — so any open row renders the list inline, uncapped.
            if isScrollable && !expanded && expandedStepIds.isEmpty {
                ScrollViewReader { proxy in
                    ScrollView(.vertical, showsIndicators: true) {
                        rows
                    }
                    .frame(height: cappedHeight)
                    // Follow the run: a step appended below the fold is the
                    // one the user wants to see, and a scroller parked at the
                    // top would report the turn's oldest news as its status.
                    .onAppear { scrollToLast(proxy) }
                    .onChange(of: steps.count) { _, _ in scrollToLast(proxy) }
                }
            } else {
                rows
            }
        }
        .padding(.leading, 2)
        .padding(.bottom, 2)
        .accessibilityElement(children: .combine)
        // The summary label replaces the children's text, which would hide an
        // open row's args/output from VoiceOver — so it only applies while
        // every row is closed.
        if expandedStepIds.isEmpty {
            content
                .accessibilityLabel("Steps taken: \(steps.map(\.label).joined(separator: ", "))")
        } else {
            content
        }
    }

    /// An open row forces the list inline (see `body`), so the header must
    /// read as expanded then too — and collapsing from that state also closes
    /// the open rows, otherwise the click would change nothing.
    private var isHeaderExpanded: Bool { expanded || !expandedStepIds.isEmpty }

    private var header: some View {
        Button {
            if isHeaderExpanded {
                expanded = false
                expandedStepIds.removeAll()
            } else {
                expanded = true
            }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: isHeaderExpanded ? "chevron.down" : "chevron.right")
                    .font(.system(size: 8, weight: .semibold))
                Text("\(steps.count) steps")
                    .font(.system(size: 10, weight: .medium))
                Spacer(minLength: 0)
            }
            .foregroundStyle(theme.current.textMuted)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(isHeaderExpanded ? "Collapse the step list" : "Show every step")
        .accessibilityLabel(isHeaderExpanded
                            ? "Collapse the \(steps.count) agent steps"
                            : "Expand the \(steps.count) agent steps")
    }

    private var rows: some View {
        VStack(alignment: .leading, spacing: Self.rowSpacing) {
            ForEach(steps) { step in
                stepRow(step)
                    .id(step.id)
            }
        }
    }

    @ViewBuilder
    private func stepRow(_ step: ChatMessage.ToolStep) -> some View {
        let hasDetail = Self.hasDetail(step)
        let isOpen = expandedStepIds.contains(step.id)
        VStack(alignment: .leading, spacing: 2) {
            let row = HStack(spacing: 6) {
                Image(systemName: step.icon)
                    .font(.system(size: 10))
                    .foregroundStyle(theme.current.textMuted)
                    .frame(width: 12, alignment: .center)
                // The trailing "…" belongs to the live status line, not to a
                // finished step — a completed action reads as "Read X", and
                // leaving the ellipsis makes every past step look stuck.
                Text(Self.rowLabel(step.label))
                    .font(.system(size: 11))
                    .foregroundStyle(theme.current.textMuted)
                    .lineLimit(1)
                    .truncationMode(.middle)
                if hasDetail {
                    Image(systemName: isOpen ? "chevron.down" : "chevron.right")
                        .font(.system(size: 7, weight: .semibold))
                        .foregroundStyle(theme.current.textMuted.opacity(0.6))
                }
                Spacer(minLength: 0)
            }
            .frame(height: Self.rowHeight)
            .contentShape(Rectangle())
            if hasDetail {
                row
                    .onTapGesture(count: 2) { toggleDetail(step.id) }
                    .help("Double-click to show this step's input and output")
                    // The non-pointer path to the same toggle: VoiceOver (and
                    // the Accessibility Keyboard) surface this as a custom
                    // action on the combined element.
                    .accessibilityAction(named: isOpen
                                         ? "Hide input and output"
                                         : "Show input and output") {
                        toggleDetail(step.id)
                    }
            } else {
                row
            }
            if isOpen {
                stepDetail(step)
            }
        }
    }

    private func toggleDetail(_ id: UUID) {
        if expandedStepIds.contains(id) {
            expandedStepIds.remove(id)
        } else {
            expandedStepIds.insert(id)
        }
    }

    /// A row only answers double-click when the wire gave it something to
    /// show — legacy-engine steps carry neither args nor output.
    static func hasDetail(_ step: ChatMessage.ToolStep) -> Bool {
        (step.args?.isEmpty == false) || (step.resultText?.isEmpty == false)
    }

    private func stepDetail(_ step: ChatMessage.ToolStep) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            if let args = step.args, !args.isEmpty {
                detailText(Self.prettyArgs(args),
                           maxLines: 8,
                           color: theme.current.textMuted)
            }
            if let result = step.resultText, !result.isEmpty {
                detailText(result,
                           maxLines: 40,
                           color: step.isError == true
                               ? theme.current.danger
                               : theme.current.textMuted)
            }
        }
        .padding(6)
        .frame(maxWidth: 720, alignment: .leading)
        .background(theme.current.surface2)
        .cornerRadius(4)
        .padding(.leading, 18)
    }

    /// Truncates BEFORE building the `Text`: `lineLimit` alone still has to
    /// lay out the whole string (up to 20k chars) on every redraw, and the
    /// parent rebuilds this view each time the running turn appends a step.
    /// The explicit note also makes the cut visible — a silent `lineLimit`
    /// cut looks like the complete output when copied.
    @ViewBuilder
    private func detailText(_ text: String, maxLines: Int, color: Color) -> some View {
        let (shown, note) = Self.truncate(text, maxLines: maxLines)
        Text(shown)
            .font(.system(size: 10, design: .monospaced))
            .foregroundStyle(color)
            .textSelection(.enabled)
        if let note {
            Text(note)
                .font(.system(size: 9))
                .foregroundStyle(theme.current.textMuted.opacity(0.7))
        }
    }

    /// A newline count alone doesn't bound the render: a 20k-char result with
    /// no line breaks (minified JSON, one long log line) wraps into hundreds
    /// of visual lines, so a character cap backstops the line cap.
    static let detailMaxChars = 4000

    static func truncate(_ text: String, maxLines: Int) -> (shown: String, note: String?) {
        let lines = text.components(separatedBy: "\n")
        let omittedLines = max(0, lines.count - maxLines)
        var shown = omittedLines > 0
            ? lines.prefix(maxLines).joined(separator: "\n")
            : text
        var note: String? = omittedLines > 0 ? "… \(omittedLines) more lines" : nil
        if shown.count > Self.detailMaxChars {
            shown = String(shown.prefix(Self.detailMaxChars))
            note = "… truncated at \(Self.detailMaxChars) characters"
        }
        return (shown, note)
    }

    /// Tool args arrive as the model's one-line JSON; an Edit call's
    /// old_string/new_string wraps into an unreadable block. Pretty-print when
    /// it parses, fall back to the raw text when it doesn't. Only open rows
    /// pay for the parse, and truncation keeps the render bounded.
    static func prettyArgs(_ raw: String) -> String {
        guard let data = raw.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data),
              let pretty = try? JSONSerialization.data(
                  withJSONObject: object,
                  options: [.prettyPrinted, .sortedKeys]),
              let text = String(data: pretty, encoding: .utf8)
        else { return raw }
        return text
    }

    /// Exposed for the row-label test: the ellipsis strip is the one piece of
    /// text transformation in this view.
    static func rowLabel(_ label: String) -> String {
        label.hasSuffix("…") ? String(label.dropLast()) : label
    }

    private func scrollToLast(_ proxy: ScrollViewProxy) {
        guard let last = steps.last?.id else { return }
        proxy.scrollTo(last, anchor: .bottom)
    }
}
