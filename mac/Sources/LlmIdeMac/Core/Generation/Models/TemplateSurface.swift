import Foundation

/// Which generation menu a template or command belongs to.
///
/// Doc Gen and Visual render the SAME `GenerationTemplateSection` over the
/// same project folders (`templates/`, `commands/`), so every template
/// appeared in both menus: Visual offered "Sprint Review" and "Decision Log",
/// and any visual template would have shown up in Doc Gen. The two surfaces
/// run the same `/generate-doc` endpoint and differ in what they are FOR —
/// Visual's sources are images — which makes this a classification problem,
/// not two generators.
///
/// Carried in the file's own marker line rather than by splitting the folders:
///
///     <!-- llmide:doc-template -->                  → .doc  (unchanged)
///     <!-- llmide:doc-template surface=visual -->   → .visual
///
/// The marker already exists to tell a template file apart from a stray `.md`,
/// so this rides on it. An absent or unrecognised `surface=` means `.doc`,
/// which is exactly today's behaviour — so every template a user already has
/// keeps working, in the menu it already appeared in, with no migration and
/// no moved paths.
public enum TemplateSurface: String, Codable, CaseIterable, Sendable {
    case doc
    case visual

    /// What the surface is called in the UI.
    public var label: String {
        switch self {
        case .doc: return "Doc Gen"
        case .visual: return "Visual"
        }
    }

    /// The surface a file with no explicit marking belongs to. Every template
    /// written before this existed is a Doc Gen template.
    public static let `default` = TemplateSurface.doc
}

/// Reading and writing the `surface=` attribute on a template/command marker.
///
/// Pure and public so `generation-contract-lab` can assert it — this
/// toolchain has no XCTest, and a marker that round-trips wrongly would
/// silently move a user's template into the other menu.
public enum TemplateSurfaceMarker {

    /// The marker line for `surface`, given a base marker like
    /// `<!-- llmide:doc-template -->`. `.doc` writes the bare marker, so a
    /// Doc Gen template's file is byte-identical to what earlier versions
    /// wrote and no diff appears in a user's project for an unchanged file.
    public static func line(base: String, surface: TemplateSurface) -> String {
        guard surface != .default else { return base }
        let inner = base
            .replacingOccurrences(of: "<!--", with: "")
            .replacingOccurrences(of: "-->", with: "")
            .trimmingCharacters(in: .whitespaces)
        return "<!-- \(inner) surface=\(surface.rawValue) -->"
    }

    /// The surface declared by `markdown`, or `.doc` when it declares none.
    ///
    /// Matches on the marker's stem (`llmide:doc-template`) rather than the
    /// whole line, so it reads both the bare and the attributed form, and
    /// tolerates the spacing a hand-edited file may pick up.
    public static func surface(in markdown: String, base: String) -> TemplateSurface {
        let stem = base
            .replacingOccurrences(of: "<!--", with: "")
            .replacingOccurrences(of: "-->", with: "")
            .trimmingCharacters(in: .whitespaces)
        for rawLine in markdown.components(separatedBy: .newlines) {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            guard line.hasPrefix("<!--"), line.contains(stem) else { continue }
            guard let range = line.range(of: "surface=") else { return .default }
            let value = line[range.upperBound...]
                .prefix { !$0.isWhitespace && $0 != "-" && $0 != ">" }
            // An unrecognised value is NOT an error to surface at scan time:
            // the file is still a template, and hiding it from every menu
            // because of a typo would lose it. It falls back to Doc Gen.
            return TemplateSurface(rawValue: String(value)) ?? .default
        }
        return .default
    }

    /// `markdown` with its marker line set to `surface`, inserting one after
    /// the `# Title` when the file has none.
    ///
    /// Needed on IMPORT: an imported `.md` is stored verbatim, so a file
    /// imported into the Visual menu would carry no marker, be read back as
    /// Doc Gen on the next rescan, and disappear from the menu the user
    /// imported it into.
    public static func ensure(in markdown: String, base: String,
                              surface: TemplateSurface) -> String {
        let stem = base
            .replacingOccurrences(of: "<!--", with: "")
            .replacingOccurrences(of: "-->", with: "")
            .trimmingCharacters(in: .whitespaces)
        let marker = line(base: base, surface: surface)
        var lines = markdown.components(separatedBy: .newlines)
        if let idx = lines.firstIndex(where: { l in
            let t = l.trimmingCharacters(in: .whitespaces)
            return t.hasPrefix("<!--") && t.contains(stem)
        }) {
            lines[idx] = marker
            return lines.joined(separator: "\n")
        }
        // No marker: place it under the title if there is one, else at the top.
        let titleIdx = lines.firstIndex { $0.trimmingCharacters(in: .whitespaces).hasPrefix("# ") }
        if let titleIdx {
            lines.insert(contentsOf: ["", marker], at: titleIdx + 1)
        } else {
            lines.insert(contentsOf: [marker, ""], at: 0)
        }
        return lines.joined(separator: "\n")
    }

    /// True when `markdown` carries this marker at all, in either form.
    public static func hasMarker(in markdown: String, base: String) -> Bool {
        let stem = base
            .replacingOccurrences(of: "<!--", with: "")
            .replacingOccurrences(of: "-->", with: "")
            .trimmingCharacters(in: .whitespaces)
        return markdown.components(separatedBy: .newlines).contains { line in
            let t = line.trimmingCharacters(in: .whitespaces)
            return t.hasPrefix("<!--") && t.contains(stem)
        }
    }
}
