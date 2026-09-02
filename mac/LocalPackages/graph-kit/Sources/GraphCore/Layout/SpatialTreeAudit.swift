import Foundation
import CoreGraphics

/// Structural self-checks for `SpatialTree`, exposed so the headless gate can
/// assert them.
///
/// These exist because the layout quality metrics were blind to a tree that was
/// badly wrong: an `insert` bug re-accumulated every point at every level below
/// a split, inflating mass and centre of mass throughout. Barnes-Hut repulsion
/// came out 1094% off an exact N² sum — with the sign inverted for some nodes —
/// and the graph still measured as well-spread, well-clustered and non-ring,
/// because a diffuse repulsion field produces a picture that *looks* plausible.
/// Only a direct comparison against ground truth catches it.
extension SpatialTree {

    public struct Audit: Sendable, Equatable {
        /// Total cells allocated. A correct quadtree over `n` points allocates
        /// far fewer than `4n`; the broken one built 81 cells for 2 points.
        public let cellCount: Int
        /// Points stored across all leaves. Must equal the number inserted —
        /// less means points were dropped, more means they were duplicated.
        public let storedPointCount: Int
        /// Root mass. Must equal the sum of the inserted masses.
        public let rootMass: Double
        /// Largest number of points in any one leaf.
        public let maxLeafOccupancy: Int
    }

    /// Walk the built tree and report what it actually contains.
    public func audit() -> Audit {
        var stored = 0
        var maxOccupancy = 0
        for cell in cellsForAudit {
            if cell.firstChild == -1 {
                stored += cell.points.count
                maxOccupancy = max(maxOccupancy, cell.points.count)
            }
        }
        return Audit(cellCount: cellsForAudit.count,
                     storedPointCount: stored,
                     rootMass: cellsForAudit.first?.mass ?? 0,
                     maxLeafOccupancy: maxOccupancy)
    }

    /// Check every internal cell's summary against its subtree.
    ///
    /// The `theta = 0` comparison is necessary but not sufficient: with theta at
    /// zero no cell ever satisfies the opening angle, so every cell is descended
    /// and the internal `mass` / `centerOfMass` values are **never read**. A
    /// future regression in exactly the accounting that caused the original bug
    /// would pass that check silently. This reads them directly.
    ///
    /// Returns the worst absolute error in mass and in centre of mass, both of
    /// which should be at floating-point noise.
    public func cellIntegrity(positions: [CGPoint],
                              masses: [Double]) -> (mass: Double, centre: Double) {
        var worstMass = 0.0
        var worstCentre = 0.0
        let cells = cellsForAudit

        /// Point indices in a cell's subtree.
        func subtree(_ cell: Int) -> [Int] {
            if cells[cell].firstChild == -1 { return cells[cell].points }
            return (0..<4).flatMap { subtree(cells[cell].firstChild + $0) }
        }

        for cell in cells.indices {
            let points = subtree(cell)
            guard !points.isEmpty else {
                // An empty cell must claim no mass.
                worstMass = max(worstMass, abs(cells[cell].mass))
                continue
            }
            let expectedMass = points.reduce(0.0) { $0 + max(masses[$1], 0.0001) }
            worstMass = max(worstMass, abs(cells[cell].mass - expectedMass))

            var sumX = 0.0, sumY = 0.0
            for point in points {
                let mass = max(masses[point], 0.0001)
                sumX += Double(positions[point].x) * mass
                sumY += Double(positions[point].y) * mass
            }
            let expectedX = sumX / expectedMass, expectedY = sumY / expectedMass
            worstCentre = max(worstCentre,
                              abs(cells[cell].centerOfMassX - expectedX))
            worstCentre = max(worstCentre,
                              abs(cells[cell].centerOfMassY - expectedY))
        }
        return (worstMass, worstCentre)
    }

    /// Exact O(n²) repulsion, using the same force law and softening as the
    /// approximation. Ground truth for the gate: at `theta = 0` the Barnes-Hut
    /// result must match this, because no cell can satisfy the opening angle.
    public static func exactRepulsion(on point: Int, positions: [CGPoint],
                                      masses: [Double], strength: Double,
                                      alpha: Double) -> CGPoint {
        let px = Double(positions[point].x), py = Double(positions[point].y)
        var deltaX = 0.0, deltaY = 0.0
        for other in positions.indices where other != point {
            var dx = Double(positions[other].x) - px
            var dy = Double(positions[other].y) - py
            var distanceSquared = dx * dx + dy * dy
            if distanceSquared < 1e-12 {
                // Must match `SpatialTree.repulsion` exactly, or this stops
                // being ground truth and the gate compares two force laws.
                let low = min(point, other), high = max(point, other)
                let angle = Double((low &* 2_654_435_761 &+ high) % 360) * .pi / 180
                let sign: Double = point < other ? -1 : 1
                dx = cos(angle) * sign
                dy = sin(angle) * sign
                distanceSquared = 1
            }
            let softened = distanceSquared + 0.5
            let scale = strength * alpha * max(masses[other], 0.0001) / softened
            deltaX += dx * scale
            deltaY += dy * scale
        }
        return CGPoint(x: deltaX, y: deltaY)
    }
}
