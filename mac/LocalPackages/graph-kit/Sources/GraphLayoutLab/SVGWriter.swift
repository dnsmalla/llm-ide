import Foundation
import CoreGraphics
import GraphCore

/// Renders a layout to SVG so a change can be looked at, not just measured.
///
/// Metrics catch regressions but cannot tell you a graph reads well, and the
/// project's own policy is that UI diffs require visual verification. This
/// writes a file that opens in any browser, using the same visual encoding the
/// Mac canvas applies — node size by importance, colour by cluster, edge opacity
/// by weight — so the SVG is a faithful preview of the real renderer.
enum SVGWriter {

    /// Distinct, colour-blind-safe cluster hues, cycled. Ordered so adjacent
    /// clusters (which the packer places near each other) get distant hues.
    private static let palette = [
        "#4E79A7", "#F28E2B", "#59A14F", "#E15759", "#B07AA1",
        "#76B7B2", "#EDC948", "#FF9DA7", "#9C755F", "#7F7F7F",
        "#2E86AB", "#C44E52", "#55A868", "#8172B2", "#CCB974",
    ]

    static func write(layout: GraphLayout, data: CGData, to path: String,
                      title: String, width: Int = 1600, height: Int = 1100) throws {
        let bounds = layout.bounds
        guard bounds.width > 0, bounds.height > 0 else { return }

        // Fit with margin, preserving aspect ratio.
        let margin = 40.0
        let scale = min((Double(width) - 2 * margin) / Double(bounds.width),
                        (Double(height) - 2 * margin) / Double(bounds.height))
        func project(_ point: CGPoint) -> (x: Double, y: Double) {
            (margin + (Double(point.x) - Double(bounds.minX)) * scale,
             margin + (Double(point.y) - Double(bounds.minY)) * scale)
        }

        var svg = """
        <svg xmlns="http://www.w3.org/2000/svg" width="\(width)" height="\(height)" \
        viewBox="0 0 \(width) \(height)">
        <rect width="100%" height="100%" fill="#12161c"/>
        <text x="\(margin)" y="26" fill="#8b98a8" font-family="ui-sans-serif,system-ui" \
        font-size="15">\(escape(title))</text>
        <g stroke-linecap="round">
        """

        // Edges first, so nodes sit on top. Weight drives opacity and width, so
        // structural edges read as structure and weak ones recede — the old
        // renderer drew every edge as the same ~11%-opacity hairline.
        for edge in data.edges {
            guard let from = layout.positions[edge.fromId],
                  let to = layout.positions[edge.toId],
                  let weight = layout.edgeWeight[GraphLayout.edgeKey(edge.fromId, edge.toId)]
            else { continue }
            let a = project(from), b = project(to)
            let opacity = 0.12 + 0.5 * weight
            let strokeWidth = 0.4 + 1.5 * weight
            svg += """
            \n<line x1="\(round2(a.x))" y1="\(round2(a.y))" x2="\(round2(b.x))" \
            y2="\(round2(b.y))" stroke="#5b6b7d" stroke-opacity="\(round2(opacity))" \
            stroke-width="\(round2(strokeWidth))"/>
            """
        }
        svg += "\n</g>\n<g>"

        // Nodes, least important first so hubs are never covered.
        let ordered = data.nodes.sorted {
            (layout.importance[$0.id] ?? 0) < (layout.importance[$1.id] ?? 0)
        }
        for node in ordered {
            guard let position = layout.positions[node.id] else { continue }
            let point = project(position)
            let radius = max((layout.radius[node.id] ?? 5) * scale, 1.2)
            let cluster = layout.community[node.id] ?? 0
            let fill = palette[cluster % palette.count]
            svg += """
            \n<circle cx="\(round2(point.x))" cy="\(round2(point.y))" r="\(round2(radius))" \
            fill="\(fill)" fill-opacity="0.88" stroke="#12161c" stroke-width="0.6"/>
            """
        }
        svg += "\n</g>"

        // Label only the most important nodes — the readable alternative to the
        // old renderer's all-or-nothing zoom threshold.
        let labelled = data.nodes
            .sorted { (layout.importance[$0.id] ?? 0) > (layout.importance[$1.id] ?? 0) }
            .prefix(28)
        svg += "\n<g font-family=\"ui-sans-serif,system-ui\" font-size=\"11\" fill=\"#dfe6ee\">"
        for node in labelled {
            guard let position = layout.positions[node.id] else { continue }
            let point = project(position)
            let radius = max((layout.radius[node.id] ?? 5) * scale, 1.2)
            svg += """
            \n<text x="\(round2(point.x + radius + 3))" y="\(round2(point.y + 3))" \
            stroke="#12161c" stroke-width="2.5" paint-order="stroke">\(escape(node.title))</text>
            """
        }
        svg += "\n</g>"

        if let quality = layout.quality {
            svg += """
            \n<text x="\(margin)" y="\(height - 16)" fill="#6f7d8c" \
            font-family="ui-monospace,monospace" font-size="11">\(escape(quality.summary))</text>
            """
        }
        svg += "\n</svg>\n"

        try svg.write(toFile: path, atomically: true, encoding: .utf8)
    }

    /// SVG for a bare position array — used to picture the legacy baseline,
    /// which carries no clusters or importance.
    static func writePlain(positions: [CGPoint], data: CGData, to path: String,
                           title: String, subtitle: String,
                           width: Int = 1600, height: Int = 1100) throws {
        guard !positions.isEmpty else { return }
        var minX = Double(positions[0].x), maxX = minX
        var minY = Double(positions[0].y), maxY = minY
        for point in positions {
            minX = min(minX, Double(point.x)); maxX = max(maxX, Double(point.x))
            minY = min(minY, Double(point.y)); maxY = max(maxY, Double(point.y))
        }
        let margin = 40.0
        let spanX = max(maxX - minX, 1), spanY = max(maxY - minY, 1)
        let scale = min((Double(width) - 2 * margin) / spanX,
                        (Double(height) - 2 * margin) / spanY)
        func project(_ point: CGPoint) -> (x: Double, y: Double) {
            (margin + (Double(point.x) - minX) * scale, margin + (Double(point.y) - minY) * scale)
        }

        var indexById: [String: Int] = [:]
        for (index, node) in data.nodes.enumerated() { indexById[node.id] = index }

        var svg = """
        <svg xmlns="http://www.w3.org/2000/svg" width="\(width)" height="\(height)" \
        viewBox="0 0 \(width) \(height)">
        <rect width="100%" height="100%" fill="#12161c"/>
        <text x="\(margin)" y="26" fill="#8b98a8" font-family="ui-sans-serif,system-ui" \
        font-size="15">\(escape(title))</text>
        <g stroke="#5b6b7d" stroke-opacity="0.11" stroke-width="0.6">
        """
        for edge in data.edges {
            guard let from = indexById[edge.fromId], let to = indexById[edge.toId],
                  from < positions.count, to < positions.count else { continue }
            let a = project(positions[from]), b = project(positions[to])
            svg += "\n<line x1=\"\(round2(a.x))\" y1=\"\(round2(a.y))\" x2=\"\(round2(b.x))\" y2=\"\(round2(b.y))\"/>"
        }
        svg += "\n</g>\n<g fill=\"#4E79A7\" fill-opacity=\"0.85\">"
        for point in positions {
            let projected = project(point)
            svg += "\n<circle cx=\"\(round2(projected.x))\" cy=\"\(round2(projected.y))\" r=\"3\"/>"
        }
        svg += """
        \n</g>
        <text x="\(margin)" y="\(height - 16)" fill="#6f7d8c" \
        font-family="ui-monospace,monospace" font-size="11">\(escape(subtitle))</text>
        </svg>
        """
        try svg.write(toFile: path, atomically: true, encoding: .utf8)
    }

    private static func round2(_ value: Double) -> String {
        String(format: "%.2f", value.isFinite ? value : 0)
    }

    private static func escape(_ text: String) -> String {
        text.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
    }
}
