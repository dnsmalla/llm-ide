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

    override func keyDown(with event: NSEvent) {
        // Only plain arrows (no ⌘/⌥/⌃/⇧) drive history; modified arrows keep
        // their normal selection/word-movement behaviour.
        let mods = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        let bare = mods.isEmpty
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
