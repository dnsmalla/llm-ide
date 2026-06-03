import Foundation
import ApplicationServices
import os.log

/// Reads captions from Microsoft Teams desktop's "Live captions" panel.
///
/// Teams (Electron-based) renders captions in a `<div role="region"
/// aria-label="Live captions">` which surfaces as an AXGroup with the
/// title "Live captions".  Inside, each caption is a `<p>` carrying a
/// speaker label as the first child and the text after.
///
/// This scraper is a starting point; concrete row layout depends on
/// the Teams build.  When the parser breaks on a new release, fix the
/// row-walk logic here and bump VERSION_TESTED below.
final class TeamsCaptionScraper: CaptionScraper {
    let source: CaptureSource = .teamsDesktop
    let bundleID: String = "com.microsoft.teams2"   // Teams 2 / new client

    private let log = Logger(subsystem: "com.meetnotes.macapp", category: "Teams")

    func snapshot() -> [(speaker: String, text: String)] {
        guard let app = AXCaptionReader.axElement(forBundleID: bundleID) else { return [] }
        // Teams puts the captions inside the meeting window as a
        // group, not in a separate window.  Find it by descending
        // from any window and matching role+description.
        var found: AXUIElement?
        var windowsValue: CFTypeRef?
        let status = AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &windowsValue)
        if status == .success, let windows = windowsValue as? [AXUIElement] {
            for window in windows {
                AXCaptionReader.walk(window, maxDepth: 16) { el in
                    if found != nil { return }
                    if let role = AXCaptionReader.string(el, attribute: kAXRoleAttribute),
                       role == kAXGroupRole,
                       let desc = AXCaptionReader.string(el, attribute: kAXDescriptionAttribute),
                       desc.lowercased().contains("live caption") {
                        found = el
                    }
                }
                if found != nil { break }
            }
        }
        guard let panel = found else { return [] }

        let texts = AXCaptionReader.descendants(of: panel, matching: kAXStaticTextRole)
        var out: [(speaker: String, text: String)] = []
        // Heuristic: alternate speaker / body lines.  Teams emits the
        // name as one static-text node and the body as the next.
        var pendingSpeaker: String?
        for el in texts {
            guard let raw = AXCaptionReader.string(el, attribute: kAXValueAttribute) else { continue }
            let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if s.isEmpty { continue }
            if pendingSpeaker == nil {
                pendingSpeaker = s
            } else {
                out.append((pendingSpeaker!, s))
                pendingSpeaker = nil
            }
        }
        if out.isEmpty && !texts.isEmpty {
            log.debug("teams panel found but speaker/body alternation didn't match")
        }
        return out
    }
}
