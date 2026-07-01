import Foundation
import ApplicationServices
import os.log

/// Reads captions from Zoom desktop's "Captions and Subtitles" panel.
///
/// The panel is a separate AXWindow whose title contains "Caption"
/// (en-US) — the exact title localizes per the user's Zoom locale, so
/// we match on substring rather than equality.  Inside the window
/// there's an `AXScrollArea` containing one `AXStaticText` per line.
/// Each line carries the format "<Speaker Name>\n<Text>" — we split
/// on the first newline to recover the speaker.
///
/// Zoom does NOT expose a structured caption API; this scraping is
/// inherently fragile and breaks with major UI redesigns, exactly
/// like the DOM-based scraper in the Chrome extension.  Plan for that:
/// log when the window vanishes, surface a UI hint, and version-pin
/// the Zoom build we're confirmed to work against.
final class ZoomCaptionScraper: CaptionScraper {
    let source: CaptureSource = .zoomDesktop
    let bundleID: String = "us.zoom.xos"

    private let log = Logger(subsystem: "com.llmide.macapp", category: "Zoom")

    func snapshot() -> [(speaker: String, text: String)] {
        guard let app = AXCaptionReader.axElement(forBundleID: bundleID) else { return [] }
        // Match either English or localized Japanese caption window
        // titles.  Adding more locales is a one-line addition here.
        guard let captionsWindow = AXCaptionReader.window(in: app, titleContains: "Caption")
                                ?? AXCaptionReader.window(in: app, titleContains: "字幕") else {
            return []
        }
        let texts = AXCaptionReader.descendants(of: captionsWindow, matching: kAXStaticTextRole)
        var out: [(speaker: String, text: String)] = []
        for el in texts {
            guard let raw = AXCaptionReader.string(el, attribute: kAXValueAttribute) else { continue }
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { continue }
            // Split on first newline: "Tanaka\nLet's start the demo."
            // Zoom emits the speaker name as a leading line in bold;
            // it shows up in AX as a normal text node prefix.
            if let nl = trimmed.firstIndex(of: "\n") {
                let speaker = String(trimmed[..<nl]).trimmingCharacters(in: .whitespaces)
                let body = String(trimmed[trimmed.index(after: nl)...]).trimmingCharacters(in: .whitespaces)
                if !speaker.isEmpty && !body.isEmpty {
                    out.append((speaker, body))
                    continue
                }
            }
            // No speaker prefix found — emit as anonymous so the line
            // isn't lost.  The orchestrator's dedup window keeps this
            // from spamming when the panel re-renders the same row.
            out.append(("Unknown", trimmed))
        }
        if out.isEmpty {
            log.debug("zoom captions panel found but produced no rows")
        }
        return out
    }
}
