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

    private let log = Logger(subsystem: "com.llmide.macapp", category: "Teams")

    func snapshot() -> [(speaker: String, text: String)] {
        guard let panel = captionPanel() else { return [] }
        let groups = AXCaptionReader.staticTextGroups(of: panel)
        let out = Self.pairCaptionRows(groups)
        if out.isEmpty && !groups.isEmpty {
            log.debug("teams panel found but no speaker/body rows matched")
        }
        return out
    }

    func isMeetingUIPresent() -> Bool {
        captionPanel() != nil
    }

    /// The "Live captions" group inside any Teams window, or nil.
    private func captionPanel() -> AXUIElement? {
        guard let app = AXCaptionReader.axElement(forBundleID: bundleID) else { return nil }
        // Teams puts the captions inside the meeting window as a group,
        // not in a separate window, so descend from each window.  The walk
        // stops at the first match (each further node is an IPC round trip
        // into Teams) and is bounded by node budget + deadline.
        let limits = AXCaptionReader.WalkLimits.within(0.5, maxDepth: 16)
        var found: AXUIElement?
        for window in AXCaptionReader.windows(of: app) {
            AXCaptionReader.walk(window, limits: limits) { el in
                guard let role = AXCaptionReader.string(el, attribute: kAXRoleAttribute),
                      role == kAXGroupRole,
                      let desc = AXCaptionReader.string(el, attribute: kAXDescriptionAttribute),
                      desc.lowercased().contains("live caption") else {
                    return .continueWalk
                }
                found = el
                return .stop
            }
            if found != nil || limits.isExpired { break }
        }
        return found
    }

    /// Pairs static-text groups (one group per AX parent) into rows.
    ///
    /// Structural pairing — first text of a group is the speaker, the rest
    /// is the body — is used when the panel actually has per-row parents
    /// (more than one group, or a single 2-text row).  A one-text group is a
    /// continuation line: Teams omits the name on consecutive lines from the
    /// same speaker, so it is attributed to the previous speaker (dropped
    /// when there is none).  This keeps one stray node from re-pairing every
    /// later row, which plain alternation did.
    ///
    /// When everything sits under ONE parent there is no structure to use;
    /// fall back to alternating speaker/body over the flat list.
    static func pairCaptionRows(_ groups: [[String]]) -> [(speaker: String, text: String)] {
        let nonEmpty = groups.filter { !$0.isEmpty }
        guard !nonEmpty.isEmpty else { return [] }
        let isStructured = nonEmpty.count > 1 || nonEmpty[0].count == 2
        guard isStructured else { return alternate(nonEmpty[0]) }

        var out: [(speaker: String, text: String)] = []
        var lastSpeaker: String?
        for group in nonEmpty {
            if group.count == 1 {
                if let speaker = lastSpeaker { out.append((speaker, group[0])) }
                continue
            }
            let speaker = group[0]
            out.append((speaker, group.dropFirst().joined(separator: " ")))
            lastSpeaker = speaker
        }
        return out
    }

    /// Flat-list heuristic: alternate speaker / body lines.
    private static func alternate(_ texts: [String]) -> [(speaker: String, text: String)] {
        var out: [(speaker: String, text: String)] = []
        var pendingSpeaker: String?
        for text in texts {
            if let speaker = pendingSpeaker {
                out.append((speaker, text))
                pendingSpeaker = nil
            } else {
                pendingSpeaker = text
            }
        }
        return out
    }
}
