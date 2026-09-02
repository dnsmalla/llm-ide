import Foundation
import CoreGraphics

/// Barnes-Hut quadtree for O(n log n) repulsion, built over a flat array of
/// nodes rather than a tree of class instances.
///
/// Replaces the previous `QuadTreeNode`, which had three defects this design
/// removes by construction:
///
/// 1. **Unbounded recursion.** Two nodes at identical or near-identical
///    positions subdivided forever, because the split test never considered
///    cell size. `maxDepth` bounds it, and a cell at the depth limit keeps a
///    bucket of coincident points instead of trying to separate them.
/// 2. **Silent mass loss.** `insert` began with `guard bounds.contains(position)`
///    and children were probed with `children?.forEach { $0.insert(...) }`, so a
///    point on the root's outer edge was rejected by every child while the root
///    had already counted it — leaving `totalMass` inconsistent with the points
///    actually stored. Here a point is routed to exactly one child by comparison
///    against the cell midpoint, and out-of-bounds points are clamped in.
/// 3. **Allocation churn.** One class instance per cell, rebuilt from scratch
///    every tick (~5000 allocations per tick at 5000 nodes). Cells live in a
///    contiguous array of structs, reused across ticks via `rebuild`.
public struct SpatialTree {

    /// A quadtree cell. Leaves carry `points`; internals carry `firstChild`.
    struct Cell {
        var centerOfMassX: Double = 0
        var centerOfMassY: Double = 0
        var mass: Double = 0
        var minX: Double = 0
        var minY: Double = 0
        var size: Double = 0
        /// Index of the first of four contiguous children, or -1 for a leaf.
        var firstChild: Int = -1
        /// Point indices held by this leaf. Only non-empty for leaves.
        var points: [Int] = []
    }

    private var cells: [Cell] = []
    /// Read-only view for `SpatialTreeAudit`, which the headless gate uses to
    /// assert the tree's structure directly rather than inferring it from
    /// layout quality (which stayed plausible while the tree was badly wrong).
    var cellsForAudit: [Cell] { cells }
    private let maxDepth: Int
    /// A leaf splits once it holds more than this many points.
    private let leafCapacity: Int

    public init(maxDepth: Int = 20, leafCapacity: Int = 1) {
        self.maxDepth = maxDepth
        // `0` would make `points.count < leafCapacity` never true, so every
        // point descends to the depth limit: 16,725 cells for 256 points.
        self.leafCapacity = max(1, leafCapacity)
    }

    /// Rebuild the tree over `positions`, weighting each point by `masses`.
    ///
    /// Mass is what lets a hub claim more space than a leaf: a node's repulsive
    /// push scales with its weighted degree, so densely-connected nodes carve
    /// out room for their neighbourhoods instead of every node pushing equally.
    public mutating func rebuild(positions: [CGPoint], masses: [Double]) {
        cells.removeAll(keepingCapacity: true)
        guard !positions.isEmpty else { return }

        var minX = positions[0].x, maxX = minX
        var minY = positions[0].y, maxY = minY
        for point in positions {
            minX = min(minX, point.x); maxX = max(maxX, point.x)
            minY = min(minY, point.y); maxY = max(maxY, point.y)
        }
        // Square, padded root so the quadrant split stays uniform in both axes.
        let side = max(Double(maxX - minX), Double(maxY - minY), 1) * 1.02
        var root = Cell()
        root.minX = Double(minX) - side * 0.01
        root.minY = Double(minY) - side * 0.01
        root.size = side
        cells.append(root)

        for index in positions.indices {
            insert(index, positions: positions, masses: masses)
        }
    }

    private mutating func insert(_ point: Int, positions: [CGPoint], masses: [Double]) {
        var cell = 0
        var depth = 0
        let x = Double(positions[point].x), y = Double(positions[point].y)
        let mass = max(masses[point], 0.0001)

        while true {
            // Accumulate the running centre of mass on the way down, so every
            // ancestor summarises its whole subtree.
            let total = cells[cell].mass + mass
            cells[cell].centerOfMassX =
                (cells[cell].centerOfMassX * cells[cell].mass + x * mass) / total
            cells[cell].centerOfMassY =
                (cells[cell].centerOfMassY * cells[cell].mass + y * mass) / total
            cells[cell].mass = total

            if cells[cell].firstChild == -1 {
                // A leaf takes the point unless it is already full and there is
                // still depth left to separate them. At the depth limit a cell
                // keeps every coincident point rather than subdividing space
                // that can no longer tell them apart.
                if cells[cell].points.count < leafCapacity || depth >= maxDepth {
                    cells[cell].points.append(point)
                    return
                }
                // Full: push the points already here one level down, then carry
                // on descending so THIS point is placed exactly once, below.
                //
                // The point must not be appended before this decision. It used
                // to be, which meant `subdivide` carried it into a child and the
                // loop then descended and accumulated it again at every
                // remaining level — inflating mass and centre of mass all the
                // way down. Two points 100 apart built 81 cells instead of 5,
                // one leaf reported mass 21 for a single mass-1 point, and
                // Barnes-Hut repulsion came out 1094% off an exact N² sum with
                // the sign inverted for some nodes.
                subdivide(cell, positions: positions, masses: masses)
            }

            cell = child(of: cell, x: x, y: y)
            depth += 1
        }
    }

    private mutating func subdivide(_ cell: Int, positions: [CGPoint], masses: [Double]) {
        let half = cells[cell].size / 2
        let baseX = cells[cell].minX, baseY = cells[cell].minY
        let first = cells.count
        for quadrant in 0..<4 {
            var child = Cell()
            child.minX = baseX + (quadrant & 1 == 1 ? half : 0)
            child.minY = baseY + (quadrant & 2 == 2 ? half : 0)
            child.size = half
            cells.append(child)
        }
        cells[cell].firstChild = first

        // Push the leaf's points down one level. Their mass is already counted
        // in this cell's centre of mass, so only the children need updating.
        let carried = cells[cell].points
        cells[cell].points = []
        for point in carried {
            let x = Double(positions[point].x), y = Double(positions[point].y)
            let mass = max(masses[point], 0.0001)
            let target = child(of: cell, x: x, y: y)
            let total = cells[target].mass + mass
            cells[target].centerOfMassX =
                (cells[target].centerOfMassX * cells[target].mass + x * mass) / total
            cells[target].centerOfMassY =
                (cells[target].centerOfMassY * cells[target].mass + y * mass) / total
            cells[target].mass = total
            cells[target].points.append(point)
        }
    }

    /// Route a point to exactly one child by comparison against the midpoint —
    /// no bounds probing, so a point can never be dropped.
    private func child(of cell: Int, x: Double, y: Double) -> Int {
        let half = cells[cell].size / 2
        let midX = cells[cell].minX + half
        let midY = cells[cell].minY + half
        var quadrant = 0
        if x >= midX { quadrant |= 1 }
        if y >= midY { quadrant |= 2 }
        return cells[cell].firstChild + quadrant
    }

    /// Accumulated repulsive force on `point`, approximating any cell whose
    /// angular size is below `theta` by its centre of mass.
    ///
    /// Returns a velocity delta, already scaled by `strength` (negative for
    /// repulsion) and `alpha`.
    /// The query point is identified by index only. It used to also take an
    /// `at:` position; if a caller ever passed one that disagreed with
    /// `positions[point]`, `containsQuery` would test the wrong cell while the
    /// leaf loop skipped the wrong index — two silent, opposite errors.
    public func repulsion(on point: Int,
                          positions: [CGPoint], masses: [Double],
                          strength: Double, theta: Double, alpha: Double) -> CGPoint {
        guard !cells.isEmpty else { return .zero }
        var deltaX = 0.0, deltaY = 0.0
        var stack: [Int] = [0]
        stack.reserveCapacity(64)
        let px = Double(positions[point].x), py = Double(positions[point].y)

        while let cell = stack.popLast() {
            guard cells[cell].mass > 0 else { continue }

            if cells[cell].firstChild == -1 {
                // Leaf: apply each point on its own. Summarising a leaf by its
                // centre of mass cannot express "everyone here except me", and
                // this is also the only place coincident points can be told
                // apart at all.
                for other in cells[cell].points where other != point {
                    var dx = Double(positions[other].x) - px
                    var dy = Double(positions[other].y) - py
                    var distanceSquared = dx * dx + dy * dy
                    if distanceSquared < 1e-12 {
                        // Exactly coincident. Derive one angle from the ORDERED
                        // pair and negate it for the higher index, so the two
                        // nodes are pushed in opposite directions and momentum
                        // is conserved. Hashing each direction independently
                        // gave near-parallel vectors for about a third of index
                        // pairs, shoving both nodes the same way — which
                        // separates nothing and only worked because collision
                        // resolution cleaned up afterwards.
                        let low = min(point, other), high = max(point, other)
                        let angle = Double((low &* 2_654_435_761 &+ high) % 360)
                            * .pi / 180
                        let sign: Double = point < other ? -1 : 1
                        dx = cos(angle) * sign
                        dy = sin(angle) * sign
                        distanceSquared = 1
                    }
                    // Soften so a near-coincident pair gets a finite push.
                    let softened = distanceSquared + 0.5
                    let scale = strength * alpha * max(masses[other], 0.0001) / softened
                    deltaX += dx * scale
                    deltaY += dy * scale
                }
                continue
            }

            let dx = cells[cell].centerOfMassX - px
            let dy = cells[cell].centerOfMassY - py
            let distanceSquared = dx * dx + dy * dy + 0.5

            // Never summarise a cell the query point is inside: its centre of
            // mass includes the point itself, so the node would repel itself —
            // and for a cluster of coincident points the resulting vector is
            // exactly zero, meaning repulsion could never separate them. The
            // bounds test uses the same `>=` midpoint comparison `child(of:)`
            // routes with, so the two can never disagree.
            let size = cells[cell].size
            let containsQuery = px >= cells[cell].minX && px < cells[cell].minX + size
                && py >= cells[cell].minY && py < cells[cell].minY + size

            if !containsQuery && size * size < theta * theta * distanceSquared {
                let scale = strength * alpha * cells[cell].mass / distanceSquared
                deltaX += dx * scale
                deltaY += dy * scale
            } else {
                let first = cells[cell].firstChild
                for quadrant in 0..<4 { stack.append(first + quadrant) }
            }
        }
        return CGPoint(x: deltaX, y: deltaY)
    }
}
