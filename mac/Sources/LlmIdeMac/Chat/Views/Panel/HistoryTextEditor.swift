import SwiftUI
import AppKit

/// A multi-line text editor backed by `NSTextView` so ↑ / ↓ can be reliably
/// intercepted for prompt-history recall.
///
/// Why not `TextEditor` + `.onKeyPress`? SwiftUI's `TextEditor` is backed by an
/// `NSTextView` that consumes the arrow keys for caret movement as soon as the
/// field holds text. `.onKeyPress(.upArrow)` therefore only fires while the
/// field is empty — so history recall worked exactly once (the first ↑ loaded
/// the newest prompt) and then went dead. Overriding `keyDown` is the only
/// dependable interception point.
///
/// `onArrowUp` / `onArrowDown` return `true` when history consumed the key (so
/// the caret must not move) and `false` to fall through to normal caret
/// movement — the gating logic lives in the caller's `historyUp`/`historyDown`.
struct HistoryTextEditor: NSViewRepresentable {
    @Binding var text: String
    var font: NSFont
    var textColor: NSColor
    /// Fish-style inline suggestion: the REMAINDER of a predicted prompt
    /// (suffix only, not the full string), drawn in `ghostColor` after the
    /// typed text. Rendered by the text view's own `draw(_:)` — never
    /// inserted into the text storage, so the binding, undo stack, and
    /// caret are untouched. nil/empty = no ghost. The caller owns the
    /// prediction and its acceptance (via `onTab`); this view only paints.
    var ghostText: String? = nil
    var ghostColor: NSColor = .placeholderTextColor
    /// Return `true` if history handled the key (consume it); `false` to let
    /// the text view move the caret normally.
    var onArrowUp: () -> Bool
    var onArrowDown: () -> Bool
    /// Autocomplete-menu keys. Each returns `true` to consume the key (menu
    /// open) or `false` to fall through to the text view's default (newline /
    /// tab insertion / nothing). nil = no menu wired (default behaviour).
    var onReturn: (() -> Bool)? = nil
    var onTab: (() -> Bool)? = nil
    var onEscape: (() -> Bool)? = nil

    func makeNSView(context: Context) -> NSScrollView {
        let textView = ArrowInterceptingTextView()
        textView.delegate = context.coordinator
        textView.isRichText = false
        textView.allowsUndo = true
        textView.drawsBackground = false
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.textContainerInset = NSSize(width: 4, height: 6)
        textView.autoresizingMask = [.width]
        textView.textContainer?.widthTracksTextView = true
        textView.font = font
        textView.textColor = textColor
        textView.string = text
        textView.onArrowUp = onArrowUp
        textView.onArrowDown = onArrowDown
        textView.onReturn = onReturn
        textView.onTab = onTab
        textView.onEscape = onEscape
        textView.ghostText = ghostText
        textView.ghostColor = ghostColor

        let scroll = NSScrollView()
        scroll.documentView = textView
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = false
        scroll.backgroundColor = .clear
        scroll.borderType = .noBorder

        // Grab first responder once the view is in a window. Without this the
        // composer starts unfocused, so keyDown never fires and ↑/↓ recall (and
        // typing) appear dead until the user clicks into the field. Deferred so
        // the window hierarchy exists; guarded so we only claim focus when
        // nothing else holds it (don't steal focus from another field).
        DispatchQueue.main.async { [weak textView] in
            guard let tv = textView, let win = tv.window else { return }
            if win.firstResponder !== tv && (win.firstResponder is NSWindow || win.firstResponder == nil) {
                win.makeFirstResponder(tv)
            }
        }
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        guard let textView = scroll.documentView as? ArrowInterceptingTextView else { return }
        // Refresh the handlers each SwiftUI update so they close over the
        // current view state (sentPrompts / historyIndex / draft).
        textView.onArrowUp = onArrowUp
        textView.onArrowDown = onArrowDown
        textView.onReturn = onReturn
        textView.onTab = onTab
        textView.onEscape = onEscape
        textView.ghostText = ghostText
        textView.ghostColor = ghostColor
        textView.font = font
        textView.textColor = textColor
        // Only push the binding into the view when it actually differs — e.g. a
        // programmatic history recall. Skipping the no-op write keeps the caret
        // where the user left it while typing (updateNSView fires on every
        // keystroke via the textDidChange → binding round-trip).
        if textView.string != text {
            textView.string = text
            // After a recall, drop the caret at the end so the next ↑ keeps
            // walking back rather than landing mid-text.
            textView.setSelectedRange(NSRange(location: (text as NSString).length, length: 0))
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, NSTextViewDelegate {
        private let parent: HistoryTextEditor
        init(_ parent: HistoryTextEditor) { self.parent = parent }

        func textDidChange(_ notification: Notification) {
            guard let tv = notification.object as? NSTextView else { return }
            parent.text = tv.string
        }
    }
}

/// `NSTextView` subclass that gives ↑ / ↓ to the supplied handlers before
/// falling back to default caret movement.
final class ArrowInterceptingTextView: NSTextView {
    var onArrowUp: (() -> Bool)?
    var onArrowDown: (() -> Bool)?
    var onReturn: (() -> Bool)?
    var onTab: (() -> Bool)?
    var onEscape: (() -> Bool)?
    /// Suffix of the predicted prompt, painted after the typed text by
    /// `draw(_:)` below. Kept OUT of the text storage on purpose.
    var ghostText: String? {
        didSet { if ghostText != oldValue { needsDisplay = true } }
    }
    var ghostColor: NSColor = .placeholderTextColor {
        didSet { if ghostColor != oldValue { needsDisplay = true } }
    }

    /// Paint the ghost suggestion after the last typed character. Using the
    /// view's own layout manager for the anchor point means the ghost lands
    /// exactly where the next typed glyph would — same font, same container
    /// insets, same wrapping — with no overlay view to keep aligned (and no
    /// sibling insertion, which this editor's history recall is fragile to;
    /// see the placeholder note in ChatComposer).
    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard var ghost = ghostText, !ghost.isEmpty, !string.isEmpty,
              // Never paint over an IME composition: the draft holds
              // uncommitted romaji/kana then, so the prediction is noise.
              !hasMarkedText(),
              let lm = layoutManager, let tc = textContainer else { return }
        // A multi-line prediction would need real line layout to render
        // faithfully; paint just its first line and mark the truncation.
        if let newline = ghost.firstIndex(of: "\n") {
            ghost = String(ghost[..<newline]) + " …"
        }
        // The tail may sit outside the scroll view's visible region, where
        // super.draw won't have laid it out — both anchor reads below need
        // committed layout to be trustworthy.
        lm.ensureLayout(for: tc)
        let origin: NSPoint
        // Character-level check (not hasSuffix("\n")): "\r\n" is ONE Swift
        // Character, so hasSuffix("\n") is false for CRLF and the else
        // branch would anchor to the line-terminator glyph, whose rect
        // extends to the container's right edge.
        if string.last?.isNewline == true {
            // The insertion point sits on the empty last line — the layout
            // manager exposes it as the extra line fragment. USED rect, like
            // the else branch: the plain fragment rect spans the container
            // from x=0, which would put the ghost lineFragmentPadding to the
            // left of where typed text actually starts.
            let r = lm.extraLineFragmentUsedRect
            origin = NSPoint(x: r.minX + textContainerOrigin.x,
                             y: r.minY + textContainerOrigin.y)
        } else {
            // Anchor to the last line fragment's USED rect, not the last
            // glyph's bounding rect: a trailing zero-advance glyph (combining
            // mark, non-ligated emoji sequence) would report the base
            // character's position and land the ghost one column short.
            let glyphCount = lm.numberOfGlyphs
            guard glyphCount > 0 else { return }
            let used = lm.lineFragmentUsedRect(forGlyphAt: glyphCount - 1, effectiveRange: nil)
            origin = NSPoint(x: used.maxX + textContainerOrigin.x,
                             y: used.minY + textContainerOrigin.y)
        }
        let attrs: [NSAttributedString.Key: Any] = [
            .font: font ?? NSFont.systemFont(ofSize: NSFont.systemFontSize),
            .foregroundColor: ghostColor,
        ]
        // NSString.draw neither wraps nor clips, so cut the ghost to the
        // width left on its line — a past prompt is usually a long sentence,
        // and an un-elided one would be guillotined mid-glyph at the view
        // edge. Line fragments end at size.width - lineFragmentPadding, so
        // subtract the padding too or the ghost overshoots into it.
        let available = tc.size.width - tc.lineFragmentPadding - (origin.x - textContainerOrigin.x)
        var fitted = Self.fit(ghost, width: available, attributes: attrs)
        if fitted.isEmpty {
            // The prediction exists but the line has no room. At least show
            // that there IS a continuation — the invariant "prediction
            // present ⇒ something visible" is what keeps Tab from accepting
            // a string the user never saw (onTab keys off promptSuggestion,
            // not off what this method managed to paint).
            let ellipsis = "…"
            guard (ellipsis as NSString).size(withAttributes: attrs).width <= available else { return }
            fitted = ellipsis
        }
        (fitted as NSString).draw(at: origin, withAttributes: attrs)
    }

    /// Longest prefix of `text` that renders within `width`, "…"-elided when
    /// cut. Binary search on the prefix length keeps it at O(log n) measures
    /// per draw instead of shave-and-remeasure's O(n).
    private static func fit(_ text: String, width: CGFloat,
                            attributes: [NSAttributedString.Key: Any]) -> String {
        guard width > 8 else { return "" }
        if (text as NSString).size(withAttributes: attributes).width <= width { return text }
        let chars = Array(text)
        var lo = 0
        var hi = chars.count
        while lo < hi {
            let mid = (lo + hi + 1) / 2
            let candidate = String(chars[..<mid]) + "…"
            if (candidate as NSString).size(withAttributes: attributes).width <= width {
                lo = mid
            } else {
                hi = mid - 1
            }
        }
        return lo > 0 ? String(chars[..<lo]) + "…" : ""
    }

    override func keyDown(with event: NSEvent) {
        // Mid-IME-composition, Return/Tab/arrows all belong to the input
        // method (candidate selection/confirmation). keyDown runs BEFORE
        // interpretKeyEvents hands the event to the IME, so intercepting
        // here would steal the key AND mutate the string under a live
        // marked range — which corrupts the composition IME-independently.
        if hasMarkedText() { super.keyDown(with: event); return }
        // Only plain arrows (no ⌘/⌥/⌃/⇧) drive history; modified arrows keep
        // their normal selection/word-movement behaviour.
        //
        // CRITICAL: arrow keys ALWAYS carry `.function` (and usually
        // `.numericPad`) in their modifier flags, so the old
        // `intersection(.deviceIndependentFlagsMask).isEmpty` check was NEVER
        // true for an arrow — it silently rejected every bare ↑/↓ and history
        // recall (plus menu nav) never fired. Only the real chord modifiers
        // (⌘⌥⌃⇧) should disqualify a "bare" arrow.
        let chordMods: NSEvent.ModifierFlags = [.command, .option, .control, .shift]
        let bare = event.modifierFlags.intersection(chordMods).isEmpty
        // Menu keys take priority while the autocomplete menu is open (the
        // handler returns false when it's closed, so normal editing — newline
        // on Return, tab insertion — is untouched). Return stays bare-only so
        // ⌘↵ keeps submitting via the SwiftUI button.
        if bare, event.keyCode == 36 /* return */, onReturn?() == true { return }
        if bare, event.keyCode == 48 /* tab */, onTab?() == true { return }
        if event.keyCode == 53 /* esc */, onEscape?() == true { return }
        if bare, event.keyCode == 126 /* up */, onArrowUp?() == true { return }
        if bare, event.keyCode == 125 /* down */, onArrowDown?() == true { return }
        super.keyDown(with: event)
    }
}
