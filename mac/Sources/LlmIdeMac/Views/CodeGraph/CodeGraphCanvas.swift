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
import GraphKit

@MainActor
struct CodeGraphCanvas: View {
    let data: CGData
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
            if !visible.contains(p1) && !visible.contains(p2) { continue }

            var alpha = edgeAlpha(e, focused: focused, focusNbrs: focusNbrs,
                                  hovered: hovered, hoverNbrs: hoverNbrs, selId: selId)
            // Kind highlight dims edges not touching the highlighted kind
            if let hk = highlight {
                let fk = data.nodes.first { $0.id == e.fromId }?.kind
                let tk = data.nodes.first { $0.id == e.toId   }?.kind
                if fk != hk && tk != hk { alpha = min(alpha, 0.06) }
            }
            if alpha < 0.01 { continue }

            let isHighlighted = (e.fromId == selId || e.toId == selId)
                || (e.fromId == focused?.id || e.toId == focused?.id)
                || (e.fromId == hovered || e.toId == hovered)

            var path = Path(); path.move(to: p1); path.addLine(to: p2)
            let colour: Color = isHighlighted
                ? t.accent.opacity(alpha)
                : t.textMuted.opacity(alpha * 0.5)
            ctx.stroke(path, with: .color(colour),
                       lineWidth: (isHighlighted ? 1.6 : 0.6) / max(scale, 0.4))
        }

        // --- Nodes + labels ---
        for n in data.nodes {
            guard let pos = effectivePos(n.id), visible.contains(pos) else { continue }

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
            let kindColor = CGPalette.color(for: n.kind)

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
            let labelOpacity: Double = activeLabel
                ? min(1.0, Double(alpha) * 1.3)
                : max(0, min(1, Double((scale - 0.9) / 0.6))) * Double(alpha)
            if showLabels && labelOpacity > 0.06 {
                let fontSize = max(CGFloat(7), CGFloat(11) / scale)
                let labelX   = pos.x + (r + 4) / scale
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
        for e in data.edges {
            deg[e.fromId, default: 0] += 1
            deg[e.toId,   default: 0] += 1
        }
        nodeDegree = deg
    }

    private func effectivePos(_ id: String) -> CGPoint? {
        positionOverrides[id] ?? nodePositions[id]
    }

    private func nodeR(id: String, prominent: Bool) -> CGFloat {
        let deg  = CGFloat(nodeDegree[id] ?? 0)
        let base: CGFloat = prominent ? 10 : 5
        return base + sqrt(deg) * 1.4
    }

    private func neighbourIds(of id: String?) -> Set<String> {
        guard let id else { return [] }
        return Set(data.edges.compactMap { e in
            if e.fromId == id { return e.toId }
            if e.toId   == id { return e.fromId }
            return nil
        })
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
        let xs = positions.map { $0.x }
        let ys = positions.map { $0.y }
        guard let minX = xs.min(), let maxX = xs.max(),
              let minY = ys.min(), let maxY = ys.max() else { return }
        let s  = min(size.width  * 0.88 / max(maxX - minX, 1),
                     size.height * 0.88 / max(maxY - minY, 1))
        let cx = (minX + maxX) / 2, cy = (minY + maxY) / 2
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

    private func fingerprint(of d: CGData) -> Int {
        var h = Hasher()
        h.combine(d.nodes.count); h.combine(d.edges.count)
        if let f = d.nodes.first?.id { h.combine(f) }
        if let l = d.nodes.last?.id  { h.combine(l) }
        return h.finalize()
    }

    private func worldPoint(from pt: CGPoint, size: CGSize) -> CGPoint {
        CGPoint(x: (pt.x - offset.width)  / scale,
                y: (pt.y - offset.height) / scale)
    }

    private func hitTest(_ point: CGPoint) -> CGNode? {
        let radius: CGFloat = max(18, 18 / max(scale, 0.3))
        var best: (CGNode, CGFloat)?
        for n in data.nodes {
            guard let pos = effectivePos(n.id) else { continue }
            let d = hypot(pos.x - point.x, pos.y - point.y)
            if d < radius, d < (best?.1 ?? .infinity) { best = (n, d) }
        }
        return best?.0
    }
}
