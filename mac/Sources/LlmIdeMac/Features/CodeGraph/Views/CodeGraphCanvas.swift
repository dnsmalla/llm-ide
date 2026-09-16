// Obsidian-style code graph renderer.
// • Labels on every node (scale-corrected, viewport-culled)
// • Node radius scales with √degree
// • Double-click: focus mode — neighbours bright, rest 8% opacity
// • Single-click: select node (drives detail panel / note)
// • Drag over a node: reposition that node
// • Drag empty space: pan canvas
// • Hover: neighbours 85%, rest 30%
// • highlightKind: dims all non-matching kinds to 15%
// • Clear-focus button in floating toolbar

import SwiftUI
import GraphCore

@MainActor
struct CodeGraphCanvas: View {
    let data: CGData
    /// Structural signals from `GraphLayoutEngine` — cluster, importance,
    /// radius, per-edge weight. Empty is valid and falls back to degree-based
    /// sizing and kind-based colour, so a graph with no layout still draws.
    var layout: GraphLayout = .empty
    /// Colour nodes by detected cluster rather than by `CGNodeKind`.
    ///
    /// Kind gives at most a handful of usable hues — this repo's generators
    /// emit only four code kinds, and `CGPalette` maps several kind pairs to
    /// the same SwiftUI colour (`.file`/`.notePlaybook` are both `.blue`), so
    /// in "All" mode code files and doc notes were indistinguishable. Cluster
    /// colour scales with the graph and shows actual subsystems.
    var colorByCluster: Bool = true
    @Binding var selected:    CGNode?
    /// Double-click sets focus; double-click same node or empty space clears it.
    @Binding var focusedNode: CGNode?
    var showLabels:    Bool         = true
    /// When set, nodes of this kind are full opacity; all others dim to 15%.
    var highlightKind: CGNodeKind?  = nil
    var onNodeOpen: ((CGNode) -> Void)? = nil

    @EnvironmentObject private var theme: ThemeStore

    // MARK: Pan / zoom
    @State private var scale:      CGFloat = 1.0
    @State private var lastScale:  CGFloat = 1.0
    @State private var offset:     CGSize  = .zero
    @State private var lastOffset: CGSize  = .zero
    @State private var canvasSize: CGSize  = .zero
    @State private var lastFitFingerprint: Int = 0

    // MARK: Node drag
    @State private var positionOverrides: [String: CGPoint] = [:]
    @State private var draggedNodeId:     String?   = nil
    @State private var dragStartLoc:      CGPoint?  = nil

    // MARK: Interaction
    @State private var hoveredNodeId: String? = nil

    // MARK: Caches (rebuilt when data changes)
    @State private var nodePositions: [String: CGPoint] = [:]
    @State private var nodeDegree:    [String: Int]     = [:]
    /// Precomputed per-frame lookups — building these once in rebuildCaches()
    /// keeps the draw loop O(n) instead of scanning all edges/nodes repeatedly
    /// (the All graph has ~6k edges; hover redraws were O(edges) × several).
    @State private var adjacency:     [String: Set<String>] = [:]
    @State private var nodeKindById:  [String: CGNodeKind]  = [:]
    /// Nodes in paint order — least important first, so a hub is never covered
    /// by a leaf drawn after it.
    @State private var drawOrder:     [CGNode]              = []

    var body: some View {
        ZStack(alignment: .topTrailing) {
            GeometryReader { geo in
                Canvas { ctx, size in
                    drawGraph(ctx: &ctx, size: size)
                }
                .background(theme.current.body)
                .onContinuousHover { phase in
                    switch phase {
                    case .active(let loc):
                        hoveredNodeId = hitTest(worldPoint(from: loc, size: geo.size))?.id
                    case .ended:
                        hoveredNodeId = nil
                    }
                }
                .gesture(dragGesture(geoSize: geo.size))
                .gesture(zoomGesture)
                .gesture(tapGestures(geoSize: geo.size))
                .onAppear {
                    canvasSize = geo.size
                    rebuildCaches()
                    fitIfNewGraph(in: geo.size)
                }
                .onChange(of: geo.size) { _, new in canvasSize = new }
                .onChange(of: data) { _, _ in
                    positionOverrides = [:]
                    rebuildCaches()
                    fitIfNewGraph(in: canvasSize)
                }
                // `drawOrder` and the radii come from `layout`, which arrives
                // separately from `data` on the cache-recovery path.
                .onChange(of: layout.importance.count) { _, _ in rebuildCaches() }
                .onChange(of: selected) { _, new in
                    centerOnSelected(new, canvas: geo.size)
                }
            }
            controls
                .padding(12)
        }
    }

    // MARK: - Drawing

    private func drawGraph(ctx: inout GraphicsContext, size: CGSize) {
        let t          = theme.current
        let focused    = focusedNode
        let hovered    = hoveredNodeId
        let selId      = selected?.id
        let highlight  = highlightKind
        let focusNbrs  = neighbourIds(of: focused?.id)
        let hoverNbrs  = neighbourIds(of: hovered)
        let selNbrs    = neighbourIds(of: selId)

        let viewport = CGRect(x: -offset.width / scale,
                              y: -offset.height / scale,
                              width:  size.width  / scale,
                              height: size.height / scale)
        let visible  = viewport.insetBy(dx: -120, dy: -120)

        ctx.concatenate(CGAffineTransform(translationX: offset.width,  y: offset.height))
        ctx.concatenate(CGAffineTransform(scaleX: scale, y: scale))

        // --- Edges ---
        for e in data.edges {
            guard let p1 = effectivePos(e.fromId),
                  let p2 = effectivePos(e.toId) else { continue }
            // Cull by the segment's bounding box, not by its endpoints. Testing
            // only the endpoints dropped any edge that crosses the viewport
            // while both of its ends sit outside it, so at high zoom long edges
            // visibly vanished.
            if !visible.intersects(CGRect(x: min(p1.x, p2.x), y: min(p1.y, p2.y),
                                          width: abs(p2.x - p1.x),
                                          height: abs(p2.y - p1.y))
                                   .insetBy(dx: -0.5, dy: -0.5)) { continue }

            var alpha = edgeAlpha(e, focused: focused, focusNbrs: focusNbrs,
                                  hovered: hovered, hoverNbrs: hoverNbrs, selId: selId)
            // Kind highlight dims edges not touching the highlighted kind
            if let hk = highlight {
                if nodeKindById[e.fromId] != hk && nodeKindById[e.toId] != hk { alpha = min(alpha, 0.06) }
            }
            if alpha < 0.01 { continue }

            let isHighlighted = (e.fromId == selId || e.toId == selId)
                || (e.fromId == focused?.id || e.toId == focused?.id)
                || (e.fromId == hovered || e.toId == hovered)

            var path = Path(); path.move(to: p1); path.addLine(to: p2)
            let weight = edgeWeight(e)
            let colour: Color = isHighlighted
                ? t.accent.opacity(alpha)
                // Weight drives prominence: a `contains`/`imports` edge reads
                // clearly, a weak reference stays faint.
                : t.textMuted.opacity(alpha * (0.30 + 0.55 * weight))
            let width = isHighlighted ? 1.9 : (0.45 + 1.0 * weight)
            ctx.stroke(path, with: .color(colour),
                       lineWidth: width / max(scale, 0.4))
        }

        // --- Nodes + labels ---
        // `drawOrder` is precomputed in `rebuildCaches`. Sorting here meant a
        // full sort with two hashed string lookups per comparison INSIDE the
        // draw closure — around 400k lookups per frame at 15k nodes, during
        // every pinch and pan.
        for n in drawOrder {
            guard let pos = effectivePos(n.id) else { continue }
            // Cull by the node's extent, not its centre — the same class of bug
            // the edge cull above was fixed for. `nodeR`'s apparent-size floor
            // makes the world radius grow to ~52 at a fitted scale of 0.05, so
            // a node centred just outside `visible` still overlaps the viewport.
            // Include the halo a selected/hovered node draws, or one at the
            // viewport edge is culled despite being visibly larger.
            let isProminentNow = n.id == selId || n.id == focused?.id || n.id == hovered
            let cullRadius = nodeR(id: n.id, prominent: isProminentNow) + 12 / max(scale, 0.05)
            guard visible.insetBy(dx: -cullRadius, dy: -cullRadius).contains(pos)
            else { continue }

            let isSel     = n.id == selId
            let isFocused = n.id == focused?.id
            let isHovered = n.id == hoveredNodeId
            var alpha     = nodeAlpha(n.id, focused: focused, focusNbrs: focusNbrs,
                                      hovered: hovered, hoverNbrs: hoverNbrs,
                                      selId: selId, selNbrs: selNbrs)
            if let hk = highlight, n.kind != hk { alpha = min(alpha, 0.15) }
            if alpha < 0.01 { continue }

            let prominent = isSel || isFocused || isHovered
            let r    = nodeR(id: n.id, prominent: prominent)
            let rect = CGRect(x: pos.x - r, y: pos.y - r, width: r * 2, height: r * 2)
            let kindColor = nodeColor(n)

            // Soft glow halo on hover / selection / focus (a larger, low-opacity
            // disc of the node's own colour) — the "professional" emphasis.
            if prominent {
                let glowR = r + (isSel || isFocused ? 9 : 6) / scale
                let glowRect = CGRect(x: pos.x - glowR, y: pos.y - glowR,
                                      width: glowR * 2, height: glowR * 2)
                ctx.fill(Path(ellipseIn: glowRect),
                         with: .color(kindColor.opacity(0.16 * Double(alpha))))
            }

            ctx.fill(Path(ellipseIn: rect),
                     with: .color(kindColor.opacity(Double(alpha))))

            if isSel || isFocused {
                ctx.stroke(
                    Path(ellipseIn: rect.insetBy(dx: -4 / scale, dy: -4 / scale)),
                    with: .color(t.accent),
                    lineWidth: 2.5 / max(scale, 0.4))
            } else if isHovered {
                ctx.stroke(
                    Path(ellipseIn: rect.insetBy(dx: -3 / scale, dy: -3 / scale)),
                    with: .color(kindColor.opacity(0.7)),
                    lineWidth: 1.5 / max(scale, 0.4))
            }

            // Labels — fade IN as you zoom past ~1.0 (declutter at low zoom),
            // but always show the active neighbourhood (selected/hovered/focused
            // node + its neighbours).
            let activeLabel = prominent
                || focusNbrs.contains(n.id) || hoverNbrs.contains(n.id) || selNbrs.contains(n.id)
            // Importance-gated level of detail. The old rule faded ALL labels
            // out below scale 0.9, so a fitted graph — the view the user
            // actually lands on — was completely unlabelled, and above that
            // threshold every label appeared at once with no collision
            // avoidance. Now the graph's most important nodes stay labelled at
            // any zoom, and the rest fade in as room appears, so there is
            // always something to read and never everything at once.
            let importance = layout.importance[n.id] ?? 0
            let alwaysLabel = importance > 0.42
            let zoomFade = max(0, min(1, Double((scale - 0.55) / 0.7)))
            let labelOpacity: Double = activeLabel
                ? min(1.0, Double(alpha) * 1.3)
                : (alwaysLabel ? max(zoomFade, 0.85) : zoomFade) * Double(alpha)
            if showLabels && labelOpacity > 0.06 {
                let fontSize = max(CGFloat(7), CGFloat(11) / scale)
                // `r` is a WORLD radius but this context is scaled, so the gap
                // has to be converted, not the radius: `(r + 4) / scale` gave a
                // screen offset of `r + 4` px regardless of how big the node
                // actually drew — 9 px beside a 30 px node at scale 6 (label
                // buried inside it), 56 px beside a 2.6 px dot at scale 0.05.
                let labelX   = pos.x + r + 4 / scale
                let labelY   = pos.y - fontSize * 0.5
                ctx.draw(
                    Text(n.title)
                        .font(.system(size: fontSize, weight: prominent ? .semibold : .regular))
                        .foregroundStyle(t.text.opacity(labelOpacity)),
                    at: CGPoint(x: labelX, y: labelY),
                    anchor: .leading
                )
            }
        }
    }

    // MARK: - Alpha helpers

    private func nodeAlpha(_ id: String,
                           focused: CGNode?, focusNbrs: Set<String>,
                           hovered: String?, hoverNbrs: Set<String>,
                           selId: String?, selNbrs: Set<String>) -> Double {
        if let f = focused {
            if id == f.id              { return 1.0 }
            if focusNbrs.contains(id)  { return 0.90 }
            return 0.07
        }
        if let h = hovered {
            if id == h                 { return 1.0 }
            if hoverNbrs.contains(id)  { return 0.85 }
            return 0.28
        }
        // Single-click selection also brightens the neighbourhood and dims the
        // rest — so clicking a node, not just double-click focus, highlights it.
        if let s = selId {
            if id == s                 { return 1.0 }
            if selNbrs.contains(id)    { return 0.90 }
            return 0.22
        }
        return 1.0
    }

    private func edgeAlpha(_ e: CGEdge,
                           focused: CGNode?, focusNbrs: Set<String>,
                           hovered: String?, hoverNbrs: Set<String>,
                           selId: String?) -> Double {
        if let f = focused {
            if e.fromId == f.id || e.toId == f.id { return 0.9 }
            return 0.03
        }
        if let h = hovered {
            if e.fromId == h || e.toId == h { return 0.8 }
            return 0.04
        }
        if let s = selId {
            if e.fromId == s || e.toId == s { return 0.85 }
            return 0.10   // dim the rest when a node is selected
        }
        return 0.22       // calm default — thin + low-opacity
    }

    // MARK: - Caches

    private func rebuildCaches() {
        nodePositions = Dictionary(
            uniqueKeysWithValues: data.nodes.map {
                ($0.id, positionOverrides[$0.id] ?? $0.position)
            })
        var deg: [String: Int] = [:]
        var adj: [String: Set<String>] = [:]
        for e in data.edges {
            deg[e.fromId, default: 0] += 1
            deg[e.toId,   default: 0] += 1
            adj[e.fromId, default: []].insert(e.toId)
            adj[e.toId,   default: []].insert(e.fromId)
        }
        nodeDegree = deg
        adjacency = adj
        nodeKindById = Dictionary(data.nodes.map { ($0.id, $0.kind) }, uniquingKeysWith: { a, _ in a })
        let importance = layout.importance
        drawOrder = importance.isEmpty
            ? data.nodes
            : data.nodes.sorted { (importance[$0.id] ?? 0) < (importance[$1.id] ?? 0) }
    }

    private func effectivePos(_ id: String) -> CGPoint? {
        positionOverrides[id] ?? nodePositions[id]
    }

    /// Drawn radius in WORLD units, with a floor on APPARENT size.
    ///
    /// The world radius alone was the single worst legibility defect: it was
    /// never divided by `scale`, unlike every line width and glow in this file.
    /// A large graph fits at scale 0.05–0.2, so a radius-6 node rendered at
    /// well under a pixel — the graph was literally a fuzzy round cloud of dots,
    /// which is what "sometimes it is in round" describes. Zoomed to scale 6 the
    /// same node became a 170 px disc.
    ///
    /// Taking the max against `minApparent / scale` guarantees a node is always
    /// at least a few pixels on screen while letting real size differences show
    /// once there is room for them.
    private func nodeR(id: String, prominent: Bool) -> CGFloat {
        let world: CGFloat
        if let laidOut = layout.radius[id] {
            world = CGFloat(laidOut)
        } else {
            // No layout: fall back to the old degree heuristic.
            let degree = CGFloat(nodeDegree[id] ?? 0)
            world = 5 + min(sqrt(degree) * 1.4, 24)
        }
        let minApparent: CGFloat = prominent ? 7 : 2.6
        let floored = max(world, minApparent / max(scale, 0.02))
        return prominent ? floored * 1.25 : floored
    }

    /// Fill colour for a node — cluster hue when a layout supplied one,
    /// otherwise the kind palette.
    private func nodeColor(_ node: CGNode) -> Color {
        guard colorByCluster, let cluster = layout.community[node.id] else {
            return CGPalette.color(for: node.kind)
        }
        return CGPalette.clusterColor(cluster)
    }

    /// Per-edge prominence from its semantic weight.
    ///
    /// Every edge used to draw as the same grey hairline at roughly 11% opacity,
    /// which is a large part of why a dense graph read as an undifferentiated
    /// wash rather than as structure. Weighting means containment and imports
    /// carry the picture while weak references recede.
    private func edgeWeight(_ edge: CGEdge) -> Double {
        layout.edgeWeight[GraphLayout.edgeKey(edge.fromId, edge.toId)]
            ?? EdgeWeight.weight(of: edge)
    }

    private func neighbourIds(of id: String?) -> Set<String> {
        guard let id else { return [] }
        return adjacency[id] ?? []
    }

    // MARK: - Gestures

    private func dragGesture(geoSize: CGSize) -> some Gesture {
        DragGesture(minimumDistance: 2)
            .onChanged { v in
                if dragStartLoc == nil {
                    dragStartLoc  = v.startLocation
                    let world     = worldPoint(from: v.startLocation, size: geoSize)
                    draggedNodeId = hitTest(world)?.id
                }
                if let nodeId = draggedNodeId {
                    let world                = worldPoint(from: v.location, size: geoSize)
                    positionOverrides[nodeId] = world
                    nodePositions[nodeId]     = world
                } else {
                    let delta = CGSize(
                        width:  v.translation.width  - lastOffset.width,
                        height: v.translation.height - lastOffset.height)
                    lastOffset = v.translation
                    offset = CGSize(width:  offset.width  + delta.width,
                                    height: offset.height + delta.height)
                }
            }
            .onEnded { _ in
                dragStartLoc  = nil
                draggedNodeId = nil
                lastOffset    = .zero
            }
    }

    private var zoomGesture: some Gesture {
        MagnificationGesture()
            .onChanged { v in
                let delta = v / lastScale; lastScale = v
                scale = max(0.05, min(6.0, scale * delta))
            }
            .onEnded { _ in lastScale = 1.0 }
    }

    private func tapGestures(geoSize: CGSize) -> some Gesture {
        // Double-tap → focus / unfocus
        SpatialTapGesture(count: 2)
            .onEnded { e in
                let world = worldPoint(from: e.location, size: geoSize)
                if let hit = hitTest(world) {
                    focusedNode = (focusedNode?.id == hit.id) ? nil : hit
                } else {
                    focusedNode = nil  // double-tap empty space → clear focus
                }
            }
            .exclusively(before:
                // Single-tap → select
                SpatialTapGesture()
                    .onEnded { e in
                        let world = worldPoint(from: e.location, size: geoSize)
                        selected  = hitTest(world)
                    }
            )
    }

    // MARK: - Floating controls

    private var controls: some View {
        let t = theme.current
        return HStack(spacing: 4) {
            iconBtn("viewfinder",           "Fit graph", t: t) {
                fit(animated: true, in: canvasSize, force: true)
            }
            iconBtn("plus.magnifyingglass",  "Zoom in", t: t) {
                withAnimation(.easeInOut(duration: 0.18)) { scale = min(6, scale * 1.3) }
            }
            iconBtn("minus.magnifyingglass", "Zoom out", t: t) {
                withAnimation(.easeInOut(duration: 0.18)) { scale = max(0.05, scale * 0.77) }
            }
            if focusedNode != nil {
                Divider().frame(height: 14)
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) { focusedNode = nil }
                } label: {
                    Image(systemName: "xmark.circle")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(t.textMuted)
                        .frame(width: 26, height: 26)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("Clear focus (or double-click empty space)")
            }
        }
        .padding(4)
        .background(t.surface.opacity(0.92), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(t.border, lineWidth: 1))
    }

    @ViewBuilder
    private func iconBtn(_ icon: String, _ tip: String, t: Theme,
                         action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(t.textMuted)
                .frame(width: 26, height: 26)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(tip)
    }

    // MARK: - Fit helpers

    private func fitIfNewGraph(in size: CGSize) {
        let fp = fingerprint(of: data)
        guard fp != lastFitFingerprint else { return }
        lastFitFingerprint = fp
        fit(animated: false, in: size, force: true)
    }

    private func fit(animated: Bool, in size: CGSize, force: Bool) {
        guard size.width > 0, size.height > 0, !data.nodes.isEmpty else { return }
        let positions = data.nodes.compactMap { effectivePos($0.id) }
            .filter { $0.x.isFinite && $0.y.isFinite }
        guard positions.count > 1 else { return }
        // Frame to the central 2nd–98th percentile rather than the absolute
        // min/max: a force layout often flings a few weakly-connected nodes far
        // out, and fitting to those extremes would zoom the whole graph down to
        // a tiny dot. Clipping the tails keeps the bulk of the graph filling the
        // viewport; the strays are still reachable by panning.
        func pct(_ a: [CGFloat], _ p: Double) -> CGFloat {
            let s = a.sorted()
            let i = Int((Double(s.count - 1) * p).rounded())
            return s[min(max(i, 0), s.count - 1)]
        }
        let xs = positions.map { $0.x }
        let ys = positions.map { $0.y }
        let minX = pct(xs, 0.02), maxX = pct(xs, 0.98)
        let minY = pct(ys, 0.02), maxY = pct(ys, 0.98)
        let spanX = maxX - minX, spanY = maxY - minY
        let cx = (minX + maxX) / 2, cy = (minY + maxY) / 2
        // Degenerate bounds: if a (possibly collapsed) layout has near-zero
        // extent in BOTH axes, the naive fit would divide by ~1 and slam scale
        // to the 6.0 cap — rendering every node screen-huge and overlapping.
        // Show such a cluster at 1:1 instead so it stays pannable/zoomable.
        let s: CGFloat = (spanX < 1 && spanY < 1)
            ? 1.0
            : min(size.width  * 0.88 / max(spanX, 1),
                  size.height * 0.88 / max(spanY, 1))
        let apply = {
            self.scale  = max(0.05, min(6.0, s))
            self.offset = CGSize(width:  size.width  / 2 - cx * s,
                                 height: size.height / 2 - cy * s)
        }
        if animated { withAnimation(.easeInOut(duration: 0.3)) { apply() } } else { apply() }
        _ = force
    }

    private func centerOnSelected(_ node: CGNode?, canvas size: CGSize) {
        guard let node, size.width > 0, size.height > 0 else { return }
        let pos = effectivePos(node.id) ?? node.position
        withAnimation(.easeInOut(duration: 0.25)) {
            offset = CGSize(width:  size.width  / 2 - pos.x * scale,
                            height: size.height / 2 - pos.y * scale)
        }
    }

    /// Identity of a laid-out graph, for deciding whether to re-fit.
    ///
    /// Counts plus the first/last id alone were not enough: they are identical
    /// before and after a re-layout, so the viewport transform fitted to one
    /// set of positions was kept for a completely different set — which is how
    /// a settled graph ended up off-screen and needing a manual "Fit". Sampling
    /// positions makes a moved graph a new graph.
    private func fingerprint(of d: CGData) -> Int {
        var h = Hasher()
        h.combine(d.nodes.count); h.combine(d.edges.count)
        if let f = d.nodes.first?.id { h.combine(f) }
        if let l = d.nodes.last?.id  { h.combine(l) }
        // Sample rather than hash every node: enough to notice a re-layout
        // without an O(n) hash on a 15k-node graph each time data changes.
        let step = max(1, d.nodes.count / 24)
        for index in stride(from: 0, to: d.nodes.count, by: step) {
            h.combine(d.nodes[index].position.x.rounded())
            h.combine(d.nodes[index].position.y.rounded())
        }
        return h.finalize()
    }

    private func worldPoint(from pt: CGPoint, size: CGSize) -> CGPoint {
        CGPoint(x: (pt.x - offset.width)  / scale,
                y: (pt.y - offset.height) / scale)
    }

    private func hitTest(_ point: CGPoint) -> CGNode? {
        // Floor only. The per-node radius below is what actually decides a hit,
        // so the outer ring of a large node is no longer unclickable — a hub
        // draws at 26 world units (×1.25 when prominent) against this 18.
        let radius: CGFloat = max(18, 18 / max(scale, 0.3))
        var best: (CGNode, CGFloat)?
        for n in data.nodes {
            guard let pos = effectivePos(n.id) else { continue }
            let d = hypot(pos.x - point.x, pos.y - point.y)
            let reach = max(radius, nodeR(id: n.id, prominent: false))
            if d < reach, d < (best?.1 ?? .infinity) { best = (n, d) }
        }
        return best?.0
    }
}
