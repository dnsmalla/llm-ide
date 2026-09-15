import Foundation
import ApplicationServices
import AppKit
import os.log

/// Helpers around `AXUIElement` for safely walking another app's
/// accessibility tree.  Every per-platform scraper (Zoom, Teams,
/// future ones) builds on these primitives.  They never throw — every
/// failure path returns nil so the caller can simply skip a poll cycle.
enum AXCaptionReader {
    private static let log = Logger(subsystem: "com.llmide.macapp", category: "AX")

    /// Fetch the AXUIElement for the running app of the given bundle ID.
    /// Returns nil if the app isn't running or we lack Accessibility permission.
    static func axElement(forBundleID bundleID: String) -> AXUIElement? {
        let runningApps = NSWorkspace.shared.runningApplications
        guard let pid = runningApps.first(where: { $0.bundleIdentifier == bundleID })?.processIdentifier else {
            return nil
        }
        return AXUIElementCreateApplication(pid)
    }

    /// Read a string-typed AX attribute.  Returns nil for any error
    /// (no permission, attribute missing, type mismatch).
    static func string(_ element: AXUIElement, attribute: String) -> String? {
        var value: CFTypeRef?
        let status = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
        guard status == .success, let s = value as? String else { return nil }
        return s
    }

    /// Read a child-array attribute.
    static func children(_ element: AXUIElement, attribute: String = kAXChildrenAttribute) -> [AXUIElement] {
        var value: CFTypeRef?
        let status = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
        guard status == .success, let arr = value as? [AXUIElement] else { return [] }
        return arr
    }

    /// Recursive search for descendants whose role matches.  Bounded
    /// depth so an unexpected cycle in the AX tree can't hang us.
    static func descendants(of root: AXUIElement, matching role: String, maxDepth: Int = 12) -> [AXUIElement] {
        var out: [AXUIElement] = []
        walk(root, depth: 0, maxDepth: maxDepth) { element in
            if let r = string(element, attribute: kAXRoleAttribute), r == role {
                out.append(element)
            }
        }
        return out
    }

    /// Generic depth-bounded walk.  The visitor is called on every
    /// element including the root.
    static func walk(_ element: AXUIElement, depth: Int = 0, maxDepth: Int = 12, visit: (AXUIElement) -> Void) {
        visit(element)
        if depth >= maxDepth { return }
        for c in children(element) {
            walk(c, depth: depth + 1, maxDepth: maxDepth, visit: visit)
        }
    }

    /// Find a window by title substring (case-insensitive).  Useful for
    /// "Captions and Subtitles" / "Live captions" panels which Zoom
    /// and Teams open as separate windows in their app's window list.
    static func window(in app: AXUIElement, titleContains needle: String) -> AXUIElement? {
        var windowsValue: CFTypeRef?
        let status = AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &windowsValue)
        guard status == .success, let windows = windowsValue as? [AXUIElement] else { return nil }
        let needleLower = needle.lowercased()
        for window in windows {
            if let title = string(window, attribute: kAXTitleAttribute),
               title.lowercased().contains(needleLower) {
                return window
            }
        }
        return nil
    }

    /// Returns true when accessibility-trusted enough to call AX APIs
    /// on other processes.  Cheap, no prompt.
    static var canRead: Bool { AXIsProcessTrusted() }
}
