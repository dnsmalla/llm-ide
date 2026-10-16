import Foundation
import ApplicationServices
import AppKit
import os.log

/// Helpers around `AXUIElement` for safely walking another app's
/// accessibility tree.  Every per-platform scraper (Zoom, Teams,
/// future ones) builds on these primitives.  They never throw — every
/// failure path returns nil so the caller can simply skip a poll cycle.
///
/// Cost bounds (a hung or huge meeting app must never stall capture):
/// - every element we hand out carries a short messaging timeout
///   (`messagingTimeout`), so one AX call against a wedged Teams/Zoom
///   gives up in a fraction of a second instead of the ~6 s system default;
/// - every walk stops at the first `.stop`, at `WalkLimits.nodeBudget`
///   visited nodes, and at the `WalkLimits` deadline.
enum AXCaptionReader {
    private static let log = Logger(subsystem: "com.llmide.macapp", category: "AX")

    /// Per-element AX messaging timeout in seconds.  NOTE: the timeout is
    /// stored per `AXUIElement` reference and is not inherited by elements
    /// copied out of it, which is why `children` / `windows` re-apply it.
    static let messagingTimeout: Float = 0.3

    /// Whether a visitor wants the walk to continue.
    enum WalkControl {
        case continueWalk
        case stop
    }

    /// Bounds for one tree walk.  `deadline` is `systemUptime`-based so a
    /// wall-clock jump cannot extend or cut a walk.
    struct WalkLimits {
        var maxDepth: Int = 12
        var nodeBudget: Int = 2_000
        var deadline: TimeInterval = .infinity

        /// Limits with a deadline `seconds` from now.
        static func within(_ seconds: TimeInterval, maxDepth: Int = 12,
                           nodeBudget: Int = 2_000) -> WalkLimits {
            WalkLimits(maxDepth: maxDepth, nodeBudget: nodeBudget,
                       deadline: ProcessInfo.processInfo.systemUptime + seconds)
        }

        var isExpired: Bool { ProcessInfo.processInfo.systemUptime >= deadline }
    }

    /// Fetch the AXUIElement for the running app of the given bundle ID.
    /// Returns nil if the app isn't running or we lack Accessibility permission.
    static func axElement(forBundleID bundleID: String) -> AXUIElement? {
        let runningApps = NSWorkspace.shared.runningApplications
        guard let pid = runningApps.first(where: { $0.bundleIdentifier == bundleID })?.processIdentifier else {
            return nil
        }
        return bounded(AXUIElementCreateApplication(pid))
    }

    /// Applies `messagingTimeout` to `element` and returns it.
    @discardableResult
    static func bounded(_ element: AXUIElement) -> AXUIElement {
        AXUIElementSetMessagingTimeout(element, messagingTimeout)
        return element
    }

    /// Read a string-typed AX attribute.  Returns nil for any error
    /// (no permission, attribute missing, type mismatch, timeout).
    static func string(_ element: AXUIElement, attribute: String) -> String? {
        var value: CFTypeRef?
        let status = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
        guard status == .success, let s = value as? String else { return nil }
        return s
    }

    /// Read a child-array attribute.  Returned elements carry the timeout.
    static func children(_ element: AXUIElement, attribute: String = kAXChildrenAttribute) -> [AXUIElement] {
        var value: CFTypeRef?
        let status = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
        guard status == .success, let arr = value as? [AXUIElement] else { return [] }
        return arr.map { bounded($0) }
    }

    /// The app's windows, each carrying the timeout.
    static func windows(of app: AXUIElement) -> [AXUIElement] {
        children(app, attribute: kAXWindowsAttribute)
    }

    /// Recursive search for descendants whose role matches.  Bounded
    /// so an unexpected cycle or a huge tree in the AX tree can't hang us.
    static func descendants(of root: AXUIElement, matching role: String,
                            limits: WalkLimits = .within(0.5)) -> [AXUIElement] {
        var out: [AXUIElement] = []
        walk(root, limits: limits) { element in
            if let r = string(element, attribute: kAXRoleAttribute), r == role {
                out.append(element)
            }
            return .continueWalk
        }
        return out
    }

    /// Static-text values under `root`, grouped by their immediate AX
    /// parent, in on-screen (pre-order) order.  The grouping is the only
    /// structural row signal AX gives us for caption panels.
    static func staticTextGroups(of root: AXUIElement,
                                 limits: WalkLimits = .within(0.5)) -> [[String]] {
        struct Node {
            let element: AXUIElement
            let id: Int
            let parentId: Int
        }
        var nextId = 1
        var groupOrder: [Int] = []
        var groups: [Int: [String]] = [:]
        boundedPreorder(
            root: Node(element: root, id: 0, parentId: -1),
            maxDepth: limits.maxDepth,
            nodeBudget: limits.nodeBudget,
            children: { node in
                if limits.isExpired { return [] }
                return children(node.element).map { child in
                    defer { nextId += 1 }
                    return Node(element: child, id: nextId, parentId: node.id)
                }
            },
            visit: { node in
                if limits.isExpired { return .stop }
                guard string(node.element, attribute: kAXRoleAttribute) == kAXStaticTextRole,
                      let raw = string(node.element, attribute: kAXValueAttribute) else {
                    return .continueWalk
                }
                let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !text.isEmpty else { return .continueWalk }
                if groups[node.parentId] == nil { groupOrder.append(node.parentId) }
                groups[node.parentId, default: []].append(text)
                return .continueWalk
            })
        return groupOrder.compactMap { groups[$0] }
    }

    /// Bounded pre-order walk.  The visitor is called on every element
    /// including the root until it returns `.stop` or a limit is hit.
    /// Returns true when the walk was cut short (stop, budget or deadline).
    @discardableResult
    static func walk(_ element: AXUIElement, limits: WalkLimits = .within(0.5),
                     visit: (AXUIElement) -> WalkControl) -> Bool {
        var cutShort = false
        let visited = boundedPreorder(
            root: element,
            maxDepth: limits.maxDepth,
            nodeBudget: limits.nodeBudget,
            children: { limits.isExpired ? [] : children($0) },
            visit: { node in
                if limits.isExpired {
                    cutShort = true
                    return .stop
                }
                let control = visit(node)
                if case .stop = control { cutShort = true }
                return control
            })
        if visited >= limits.nodeBudget { cutShort = true }
        return cutShort
    }

    /// Pure, iterative pre-order traversal shared by every walk (and unit
    /// tested with a plain tree).  Children are visited in order; descent
    /// stops at `maxDepth`; the whole walk stops after `nodeBudget` visits or
    /// as soon as `visit` returns `.stop` — no further nodes are touched,
    /// which matters because each touch is an IPC round trip.
    /// Returns the number of nodes visited.
    @discardableResult
    static func boundedPreorder<Node>(root: Node, maxDepth: Int, nodeBudget: Int,
                                      children: (Node) -> [Node],
                                      visit: (Node) -> WalkControl) -> Int {
        var stack: [(node: Node, depth: Int)] = [(root, 0)]
        var visited = 0
        while let entry = stack.popLast() {
            guard visited < nodeBudget else { break }
            visited += 1
            if case .stop = visit(entry.node) { break }
            guard entry.depth < maxDepth else { continue }
            for child in children(entry.node).reversed() {
                stack.append((child, entry.depth + 1))
            }
        }
        return visited
    }

    /// Find a window by title substring (case-insensitive).  Useful for
    /// "Captions and Subtitles" / "Live captions" panels which Zoom
    /// and Teams open as separate windows in their app's window list.
    static func window(in app: AXUIElement, titleContains needle: String) -> AXUIElement? {
        let needleLower = needle.lowercased()
        for window in windows(of: app) {
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
