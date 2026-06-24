# 3D Graph Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional SceneKit 3D rendering of the knowledge/code graph, switchable from the 2D `CodeGraphCanvas` with a `2D / 3D` toggle.

**Architecture:** Three self-contained units — `CGSimulation3D` (a 3D force layout mirroring the 2D `CGSimulation`), `Graph3DView` (an `NSViewRepresentable` SceneKit renderer), and a small integration in `UAGraphView` (toggle + per-mode settled-position cache + embed swap). All reuse the existing `CGData`, `GraphPrune`, `CGPalette`, and `selectedNode` binding.

**Tech Stack:** Swift, SwiftUI, SceneKit, simd. GraphKit package (`CGData`/`CGNode`/`CGEdge`).

## Global Constraints

- Target is `mac/`; build with `mac/Scripts/build.sh` (run the Bash tool with `dangerouslyDisableSandbox: true`). Expected tail: `[build] ok — …/LlmIdeMac.app`.
- `swift test` for the Mac target is **blocked** by a Testing.framework SDK/compiler skew. Mac code is authored and verified with `swift build` only; tests are authored but **not run** locally. Push with `--no-verify`.
- No new third-party dependencies — SceneKit ships with macOS.
- Reuse unchanged: `CGData`/`CGNode`/`CGEdge` (GraphKit), `GraphPrune.capDegree`, `CGPalette.color(for:)`, the `selectedNode` binding + detail panel.
- 2D force tuning to carry over verbatim into 3D: `kRepulsion = 1500`, `kAttraction = 0.07`, `restLength = 90`, `damping = 0.88`, centering `0.03`, velocity clamp `maxV = 250`, `alpha = 0.05`.
- Node radius formula (shared with `CodeGraphCanvas.nodeR`): `5 + min(sqrt(degree) * 1.4, 24)`.
- Repulsion is O(n²) per tick — **no octree** in v1.
- v1 scope excludes: drag-to-reposition, focus-dim, kind filter, always-on labels, octree.
- Commit footer on every commit:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

---

## File Structure

- **Create** `mac/Sources/LlmIdeMac/CodeGraph/CGSimulation3D.swift` — 3D force layout. Pure logic, no UIKit/SceneKit. One responsibility: settle `CGData` into `[String: SIMD3<Float>]`.
- **Create** `mac/Tests/LlmIdeMacTests/CGSimulation3DTests.swift` — bounded/finite invariant for the 3D sim.
- **Create** `mac/Sources/LlmIdeMac/Views/CodeGraph/Graph3DView.swift` — SceneKit renderer (`NSViewRepresentable` + `Coordinator`). One responsibility: render given positions + handle camera/selection.
- **Modify** `mac/Sources/LlmIdeMac/Views/CodeGraph/UAGraphView.swift` — add the `2D/3D` toggle, the per-mode 3D position cache + background settle, and swap the renderer at the two embed sites (`canvasPanel` ~line 751, `expandedGraphOverlay` ~line 1096).

---

### Task 1: `CGSimulation3D` — 3D force layout

**Files:**
- Create: `mac/Sources/LlmIdeMac/CodeGraph/CGSimulation3D.swift`
- Test: `mac/Tests/LlmIdeMacTests/CGSimulation3DTests.swift`

**Interfaces:**
- Consumes: `CGData` (from GraphKit) — uses `data.nodes` (`.id`) and `data.edges` (`.fromId`, `.toId`).
- Produces:
  - `final class CGSimulation3D` with `init(data: CGData)`
  - `func settle(maxIterations: Int = 150, threshold: Float = 0.4)`
  - `func positions() -> [String: SIMD3<Float>]`

- [ ] **Step 1: Write the failing test**

Create `mac/Tests/LlmIdeMacTests/CGSimulation3DTests.swift`:

```swift
import XCTest
import simd
import GraphKit
@testable import LlmIdeMac

/// Mirrors CGSimulationTests: a dense hub graph must settle to bounded, finite
/// 3D positions. The velocity clamp (carried over from the 2D sim) makes
/// divergence impossible; unclamped this fixture reaches ~1e20.
final class CGSimulation3DTests: XCTestCase {

    private func node(_ id: String) -> CGNode { CGNode(id: id, title: id, kind: .memoryChunk) }

    /// 1200 nodes; node 0 is a hub linked to all others, every node links to
    /// its next 40 neighbours — ~49k edges, dense enough to diverge unclamped.
    private func denseHubGraph(n: Int = 1200) -> CGData {
        let nodes = (0..<n).map { node("n\($0)") }
        var edges: [CGEdge] = []
        for j in 1..<n { edges.append(CGEdge(fromId: "n0", toId: "n\(j)", kind: .relatedTo)) }
        for i in 1..<n {
            for k in 1...40 {
                let j = (i + k) % n
                if j != i { edges.append(CGEdge(fromId: "n\(i)", toId: "n\(j)", kind: .relatedTo)) }
            }
        }
        return CGData(nodes: nodes, edges: edges)
    }

    func testDenseGraphSettlesToBoundedFinite3DPositions() {
        let sim = CGSimulation3D(data: denseHubGraph())
        sim.settle(maxIterations: 60)
        let pos = sim.positions()

        XCTAssertEqual(pos.count, 1200)
        XCTAssertTrue(pos.values.allSatisfy { $0.x.isFinite && $0.y.isFinite && $0.z.isFinite },
                      "settle produced non-finite positions")

        let xs = pos.values.map { $0.x }, ys = pos.values.map { $0.y }, zs = pos.values.map { $0.z }
        let spanX = xs.max()! - xs.min()!
        let spanY = ys.max()! - ys.min()!
        let spanZ = zs.max()! - zs.min()!
        XCTAssertLessThan(spanX, 100_000, "x diverged — velocity clamp missing?")
        XCTAssertLessThan(spanY, 100_000, "y diverged — velocity clamp missing?")
        XCTAssertLessThan(spanZ, 100_000, "z diverged — velocity clamp missing?")
    }
}
```

- [ ] **Step 2: Try to run the test, confirm it cannot build yet**

Run: `cd mac && swift build 2>&1 | tail -3` (with `dangerouslyDisableSandbox: true`)
Expected: build fails — `cannot find 'CGSimulation3D' in scope`. (Note: `swift test` is blocked by the toolchain skew, so we verify via `swift build`; the test documents the invariant and runs once the toolchain is fixed.)

- [ ] **Step 3: Implement `CGSimulation3D`**

Create `mac/Sources/LlmIdeMac/CodeGraph/CGSimulation3D.swift`:

```swift
import Foundation
import simd
import GraphKit

/// 3D force-directed layout — the SIMD3 analogue of `CGSimulation`. Carries
/// over the exact tuning validated for the 2D sim, including the per-node
/// velocity clamp that stops dense graphs (a hub with 1000+ edges) from
/// diverging to astronomically large coordinates. Repulsion is O(n²) per tick;
/// at the app's node counts (≤~1600) this settles in ~1–2s off the main actor.
public final class CGSimulation3D: @unchecked Sendable {

    private struct NodeState {
        let id: String
        var position: SIMD3<Float>
        var velocity: SIMD3<Float> = .zero
    }

    private var nodes: [NodeState]
    private let edges: [CGEdge]

    public init(data: CGData) {
        let n = data.nodes.count
        // Fibonacci-sphere initial spread so superimposed nodes have a
        // direction to separate along (the 3D analogue of the 2D golden-angle
        // jitter). Radius scales with node count so big graphs don't start
        // pathologically dense.
        let radius = Float(max(80, Int(Double(n).squareRoot() * 12)))
        let golden = Float.pi * (3 - (5 as Float).squareRoot())   // ~2.39996
        self.nodes = data.nodes.enumerated().map { idx, node in
            let i = Float(idx)
            let y = n > 1 ? 1 - (i / Float(n - 1)) * 2 : 0        // 1 … -1
            let r = (1 - y * y).squareRoot()
            let theta = golden * i
            let p = SIMD3<Float>(cos(theta) * r, y, sin(theta) * r) * radius
            return NodeState(id: node.id, position: p)
        }
        self.edges = data.edges
    }

    /// Run up to `maxIterations` ticks, stopping early when the peak speed drops
    /// below `threshold`. Safe to call off the main actor.
    public func settle(maxIterations: Int = 150, threshold: Float = 0.4) {
        guard nodes.count > 1 else { return }
        for i in 0..<maxIterations {
            tick()
            if i > 30 {
                let maxV = nodes.reduce(Float(0)) { max($0, length($1.velocity)) }
                if maxV < threshold { break }
            }
        }
    }

    public func positions() -> [String: SIMD3<Float>] {
        Dictionary(uniqueKeysWithValues: nodes.map { ($0.id, $0.position) })
    }

    private func tick() {
        let n = nodes.count
        guard n > 1 else { return }

        let alpha:       Float = 0.05
        let kRepulsion:  Float = 1500
        let kAttraction: Float = 0.07
        let restLength:  Float = 90
        let damping:     Float = 0.88
        let maxV:        Float = 250

        // Spring attraction along edges.
        let idxById = Dictionary(uniqueKeysWithValues: nodes.enumerated().map { ($1.id, $0) })
        for e in edges {
            guard let i = idxById[e.fromId], let j = idxById[e.toId] else { continue }
            let delta = nodes[j].position - nodes[i].position
            let d = max(length(delta), 0.1)
            let f = (d - restLength) * kAttraction
            let dir = delta / d
            nodes[i].velocity += f * dir
            nodes[j].velocity -= f * dir
        }

        // O(n²) repulsion (no octree at this scale).
        for i in 0..<n {
            var force = SIMD3<Float>.zero
            let pi = nodes[i].position
            for j in 0..<n where j != i {
                let delta = pi - nodes[j].position
                let d2 = simd_length_squared(delta) + 0.1
                force += (kRepulsion / d2) * (delta / d2.squareRoot())
            }
            nodes[i].velocity += force
        }

        // Centering toward the origin + clamp + integrate.
        for i in 0..<n {
            nodes[i].velocity += -nodes[i].position * 0.03
            let speed = length(nodes[i].velocity)
            if speed > maxV { nodes[i].velocity *= (maxV / speed) }
            nodes[i].position += nodes[i].velocity * alpha
            nodes[i].velocity *= damping
        }
    }
}
```

- [ ] **Step 4: Build to verify it compiles**

Run: `cd mac && ./Scripts/build.sh 2>&1 | tail -2` (with `dangerouslyDisableSandbox: true`)
Expected: `[build] ok — …/LlmIdeMac.app`. (The test file is in the test target; it does not affect the app build, but it must compile against the public surface — confirm names match: `CGSimulation3D(data:)`, `settle(maxIterations:threshold:)`, `positions()`.)

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/CodeGraph/CGSimulation3D.swift mac/Tests/LlmIdeMacTests/CGSimulation3DTests.swift
git commit -m "$(printf 'feat(mac): CGSimulation3D — 3D force layout for the graph view\n\nSIMD3 analogue of CGSimulation with the same validated tuning (kRep 1500,\nrest 90, centering 0.03, velocity clamp 250) and Fibonacci-sphere init.\nO(n^2) repulsion; settles off the main actor. Adds a bounded/finite\ninvariant test (swift test blocked by toolchain skew; build-verified).\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 2: `Graph3DView` — SceneKit renderer

**Files:**
- Create: `mac/Sources/LlmIdeMac/Views/CodeGraph/Graph3DView.swift`

**Interfaces:**
- Consumes:
  - `CGSimulation3D.positions()` → `[String: SIMD3<Float>]` (passed in by the caller).
  - `CGData`, `CGPalette.color(for:)` → `Color`, `CGNode.id/title/kind`.
- Produces:
  - `struct Graph3DView: NSViewRepresentable` with init `Graph3DView(data: CGData, positions: [String: SIMD3<Float>], selected: Binding<CGNode?>)`.

- [ ] **Step 1: Implement `Graph3DView`**

Create `mac/Sources/LlmIdeMac/Views/CodeGraph/Graph3DView.swift`:

```swift
import SwiftUI
import SceneKit
import simd
import GraphKit

/// SceneKit 3D renderer for the graph. Visual-exploration scope: orbit/zoom/pan
/// (SceneKit's built-in camera), click-to-select (drives the shared
/// `selected` binding → the existing detail panel), kind colours, and a
/// billboard label for the selected node only. No drag/focus/filter (see the
/// design spec). Positions are supplied pre-settled by `CGSimulation3D`.
struct Graph3DView: NSViewRepresentable {
    let data: CGData
    let positions: [String: SIMD3<Float>]
    @Binding var selected: CGNode?

    @EnvironmentObject private var theme: ThemeStore

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> SCNView {
        let view = SCNView()
        view.allowsCameraControl = true          // orbit / zoom / pan
        view.autoenablesDefaultLighting = true
        view.backgroundColor = .clear
        view.antialiasingMode = .multisampling2X
        let scene = SCNScene()
        view.scene = scene
        context.coordinator.scnView = view
        context.coordinator.rebuild(in: scene)

        let click = NSClickGestureRecognizer(target: context.coordinator,
                                             action: #selector(Coordinator.handleClick(_:)))
        view.addGestureRecognizer(click)
        return view
    }

    func updateNSView(_ view: SCNView, context: Context) {
        // Rebuild only when the graph identity or positions change.
        context.coordinator.parent = self
        let fp = context.coordinator.fingerprint(data: data, positions: positions)
        if fp != context.coordinator.lastFingerprint, let scene = view.scene {
            context.coordinator.lastFingerprint = fp
            context.coordinator.rebuild(in: scene)
        }
        context.coordinator.updateSelectionLabel()
    }

    // Shared radius rule with the 2D canvas (CodeGraphCanvas.nodeR).
    static func radius(forDegree deg: Int) -> CGFloat {
        5 + min(sqrt(CGFloat(deg)) * 1.4, 24)
    }

    final class Coordinator: NSObject {
        var parent: Graph3DView
        weak var scnView: SCNView?
        var lastFingerprint: Int = 0
        private var nodeById: [String: SCNNode] = [:]
        private var cgNodeById: [String: CGNode] = [:]
        private let rootNode = SCNNode()
        private var labelNode: SCNNode?

        init(_ parent: Graph3DView) { self.parent = parent }

        func fingerprint(data: CGData, positions: [String: SIMD3<Float>]) -> Int {
            var h = Hasher()
            h.combine(data.nodes.count); h.combine(data.edges.count); h.combine(positions.count)
            if let f = data.nodes.first?.id { h.combine(f) }
            return h.finalize()
        }

        func rebuild(in scene: SCNScene) {
            rootNode.childNodes.forEach { $0.removeFromParentNode() }
            rootNode.removeFromParentNode()
            nodeById.removeAll(); cgNodeById.removeAll()

            let data = parent.data
            let pos = parent.positions

            // Degree for sizing.
            var deg: [String: Int] = [:]
            for e in data.edges { deg[e.fromId, default: 0] += 1; deg[e.toId, default: 0] += 1 }

            // Nodes as spheres.
            for n in data.nodes {
                guard let p = pos[n.id] else { continue }
                cgNodeById[n.id] = n
                let sphere = SCNSphere(radius: Graph3DView.radius(forDegree: deg[n.id] ?? 0))
                sphere.segmentCount = 12
                let mat = SCNMaterial()
                mat.diffuse.contents = NSColor(CGPalette.color(for: n.kind))
                sphere.materials = [mat]
                let scn = SCNNode(geometry: sphere)
                scn.position = SCNVector3(p.x, p.y, p.z)
                scn.name = n.id
                rootNode.addChildNode(scn)
                nodeById[n.id] = scn
            }

            // Edges as one batched line geometry.
            if let edgeNode = Self.makeEdgeNode(edges: data.edges, positions: pos) {
                rootNode.addChildNode(edgeNode)
            }

            scene.rootNode.addChildNode(rootNode)
            frameCamera(in: scene, positions: pos)
            labelNode = nil
            updateSelectionLabel()
        }

        /// One SCNGeometry holding every edge as a line primitive (a single
        /// draw call) — cheap even at ~6k edges.
        static func makeEdgeNode(edges: [CGEdge], positions: [String: SIMD3<Float>]) -> SCNNode? {
            var verts: [SCNVector3] = []
            var indices: [Int32] = []
            verts.reserveCapacity(edges.count * 2)
            for e in edges {
                guard let a = positions[e.fromId], let b = positions[e.toId] else { continue }
                indices.append(Int32(verts.count)); verts.append(SCNVector3(a.x, a.y, a.z))
                indices.append(Int32(verts.count)); verts.append(SCNVector3(b.x, b.y, b.z))
            }
            guard !verts.isEmpty else { return nil }
            let src = SCNGeometrySource(vertices: verts)
            let elem = SCNGeometryElement(indices: indices, primitiveType: .line)
            let geo = SCNGeometry(sources: [src], elements: [elem])
            let mat = SCNMaterial()
            mat.diffuse.contents = NSColor.gray.withAlphaComponent(0.18)
            mat.lightingModel = .constant
            geo.materials = [mat]
            return SCNNode(geometry: geo)
        }

        /// Frame the camera to the bounding sphere of the layout; fall back to a
        /// fixed distance for degenerate/zero bounds (mirrors the 2D fit guard).
        func frameCamera(in scene: SCNScene, positions: [String: SIMD3<Float>]) {
            scene.rootNode.childNode(withName: "camera", recursively: false)?.removeFromParentNode()
            let pts = Array(positions.values)
            let center: SIMD3<Float>
            let dist: Float
            if pts.count > 1 {
                let sum = pts.reduce(SIMD3<Float>.zero, +)
                center = sum / Float(pts.count)
                let maxR = pts.map { length($0 - center) }.max() ?? 100
                dist = max(maxR, 1) * 2.4
            } else {
                center = .zero; dist = 300
            }
            let cam = SCNCamera()
            cam.zFar = Double(dist) * 6
            let camNode = SCNNode()
            camNode.camera = cam
            camNode.name = "camera"
            camNode.position = SCNVector3(center.x, center.y, center.z + dist)
            camNode.look(at: SCNVector3(center.x, center.y, center.z))
            scene.rootNode.addChildNode(camNode)
            scnView?.pointOfView = camNode
        }

        @objc func handleClick(_ gr: NSClickGestureRecognizer) {
            guard let view = scnView else { return }
            let p = gr.location(in: view)
            let hits = view.hitTest(p, options: [SCNHitTestOption.searchMode: SCNHitTestSearchMode.closest.rawValue])
            if let id = hits.first(where: { $0.node.name != nil })?.node.name,
               let node = cgNodeById[id] {
                parent.selected = node
            } else {
                parent.selected = nil
            }
            updateSelectionLabel()
        }

        /// Billboard label for the selected node only.
        func updateSelectionLabel() {
            labelNode?.removeFromParentNode(); labelNode = nil
            guard let sel = parent.selected, let host = nodeById[sel.id] else { return }
            let text = SCNText(string: sel.title, extrusionDepth: 0)
            text.font = .systemFont(ofSize: 14)
            text.flatness = 0.4
            text.firstMaterial?.diffuse.contents = NSColor.labelColor
            let label = SCNNode(geometry: text)
            // Scale text down to world units and lift it above the node.
            let r = Float(Graph3DView.radius(forDegree: 0))
            label.scale = SCNVector3(0.5, 0.5, 0.5)
            label.position = SCNVector3(0, r + 8, 0)
            label.constraints = [SCNBillboardConstraint()]   // always faces camera
            host.addChildNode(label)
            labelNode = label
        }
    }
}
```

- [ ] **Step 2: Build to verify it compiles**

Run: `cd mac && ./Scripts/build.sh 2>&1 | tail -2` (with `dangerouslyDisableSandbox: true`)
Expected: `[build] ok — …/LlmIdeMac.app`. If `NSColor(CGPalette.color(for:))` fails (SwiftUI `Color` → `NSColor`), wrap as `NSColor(parent ... )` is unavailable on older SDKs — use `NSColor(theme-independent)`. The supported form on this target is `NSColor(CGPalette.color(for: n.kind))` (SwiftUI `Color` is convertible to `NSColor` on macOS 12+). If the build flags it, fall back to resolving via `CGPalette` returning a platform colour — confirm by reading `Views/CodeGraph/CGPalette.swift`.

- [ ] **Step 3: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/CodeGraph/Graph3DView.swift
git commit -m "$(printf 'feat(mac): Graph3DView — SceneKit renderer for the 3D graph\n\nNSViewRepresentable around SCNView: kind-coloured degree-sized spheres,\nbatched line geometry for edges, orbit camera framed to the layout bounds,\nclick-to-select into the shared selected binding, billboard label for the\nselected node. Visual-exploration scope only.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 3: `UAGraphView` integration — toggle, cache, embed swap

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/CodeGraph/UAGraphView.swift`

**Interfaces:**
- Consumes: `CGSimulation3D(data:).settle()` + `.positions()`; `Graph3DView(data:positions:selected:)`.
- Produces: no new public surface; internal `@State` + a helper `settle3DIfNeeded()`.

- [ ] **Step 1: Add the 3D state and per-mode position cache**

Find the selection state (near `UAGraphView.swift:131`):

```swift
    @State private var selectedNode: CGNode?
```

Add immediately after it:

```swift
    /// 3D rendering toggle + per-mode cache of settled 3D positions, so
    /// flipping 2D⇄3D (or revisiting a mode) doesn't re-run the 3D settle.
    @State private var render3D = false
    @State private var positions3DByMode: [Mode: [String: SIMD3<Float>]] = [:]
```

Add the simd import at the top of the file if not present (check the existing `import` block near the top; add `import simd` if missing).

- [ ] **Step 2: Add the background settle helper**

Add this method next to `settlePhysics` (near `UAGraphView.swift:1279`), mirroring its superseded-run guard:

```swift
    /// Compute 3D positions for the current mode's displayData in the
    /// background, once, and cache them. Mirrors settlePhysics's guard so a
    /// stale run can't overwrite a newer mode's cache.
    private func settle3DIfNeeded() {
        let expectedMode = mode
        guard positions3DByMode[expectedMode] == nil else { return }
        let data = displayData
        guard data.nodes.count > 2 else {
            positions3DByMode[expectedMode] = [:]   // trivial graph: nothing to settle
            return
        }
        let iterations: Int
        switch data.nodes.count {
        case ..<300:   iterations = 220
        case ..<700:   iterations = 180
        case ..<1200:  iterations = 150
        default:       iterations = 120
        }
        Task.detached(priority: .userInitiated) {
            let sim = CGSimulation3D(data: data)
            sim.settle(maxIterations: iterations)
            if Task.isCancelled { return }
            let pos = sim.positions()
            await MainActor.run {
                guard self.mode == expectedMode,
                      self.displayData.nodes.count == data.nodes.count else { return }
                self.positions3DByMode[expectedMode] = pos
            }
        }
    }
```

- [ ] **Step 3: Invalidate the cache when the graph for a mode changes**

`displayData` is recomputed by `recomputeDisplayData()`. Drop the stale 3D positions for the current mode whenever `fullData` changes. Find (near `UAGraphView.swift:368`):

```swift
        .onChange(of: fullData)      { _, _ in recomputeDisplayData() }
```

Replace with:

```swift
        .onChange(of: fullData)      { _, _ in
            recomputeDisplayData()
            positions3DByMode[mode] = nil          // 3D layout is stale for this mode
            if render3D { settle3DIfNeeded() }
        }
```

- [ ] **Step 4: Add the 2D/3D toggle to the canvas toolbar**

Find the Labels toggle in the canvas toolbar (near `UAGraphView.swift:1021`):

```swift
                Toggle(isOn: $showLabels) {
                    Label("Labels", systemImage: showLabels ? "text.bubble.fill" : "text.bubble")
```

Immediately **before** that `Toggle(isOn: $showLabels)`, insert a 2D/3D picker:

```swift
                Picker("", selection: $render3D) {
                    Text("2D").tag(false)
                    Text("3D").tag(true)
                }
                .pickerStyle(.segmented)
                .fixedSize()
                .onChange(of: render3D) { _, on in if on { settle3DIfNeeded() } }
                .help("Switch between the 2D canvas and the 3D scene")
```

- [ ] **Step 5: Swap the renderer at the inline embed site**

Find the inline embed in `canvasPanel` (near `UAGraphView.swift:751`):

```swift
                } else {
                    CodeGraphCanvas(data: displayData, selected: $selectedNode,
                                    focusedNode: $focusedNode,
                                    showLabels: showLabels,
                                    highlightKind: filterKind,
                                    onNodeOpen: openNode)
                }
```

Replace with:

```swift
                } else if render3D {
                    Graph3DView(data: displayData,
                                positions: positions3DByMode[mode] ?? [:],
                                selected: $selectedNode)
                } else {
                    CodeGraphCanvas(data: displayData, selected: $selectedNode,
                                    focusedNode: $focusedNode,
                                    showLabels: showLabels,
                                    highlightKind: filterKind,
                                    onNodeOpen: openNode)
                }
```

- [ ] **Step 6: Swap the renderer at the expanded-overlay embed site**

Find the expanded overlay embed (near `UAGraphView.swift:1096`):

```swift
            CodeGraphCanvas(data: displayData, selected: $selectedNode,
                                    focusedNode: $focusedNode,
                                    showLabels: showLabels,
                                    highlightKind: filterKind,
```

This is the start of a `CodeGraphCanvas(...)` call inside `expandedGraphOverlay`. Wrap it in a conditional so 3D is honoured there too. Replace the whole `CodeGraphCanvas( … )` call (read through its closing `)` — it ends with `onNodeOpen: openNode)`) with:

```swift
            if render3D {
                Graph3DView(data: displayData,
                            positions: positions3DByMode[mode] ?? [:],
                            selected: $selectedNode)
            } else {
                CodeGraphCanvas(data: displayData, selected: $selectedNode,
                                focusedNode: $focusedNode,
                                showLabels: showLabels,
                                highlightKind: filterKind,
                                onNodeOpen: openNode)
            }
```

- [ ] **Step 7: Build to verify it compiles**

Run: `cd mac && ./Scripts/build.sh 2>&1 | tail -2` (with `dangerouslyDisableSandbox: true`)
Expected: `[build] ok — …/LlmIdeMac.app`.

- [ ] **Step 8: Visual verification**

Run (with `dangerouslyDisableSandbox: true`):

```bash
pkill -9 -f LlmIdeMac; pkill -9 -f server.mjs; sleep 2
open mac/LlmIdeMac.app
```

Confirm by driving the app (or ask the operator for a screenshot): generate a graph, flip the toolbar to **3D** — nodes appear as a 3D cloud you can orbit/zoom/pan; clicking a node opens the detail panel and shows its label; flipping back to **2D** restores the canvas with the selection intact; switching modes (Code/InfiniteBrain/All) re-settles 3D once and caches it.

- [ ] **Step 9: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/CodeGraph/UAGraphView.swift
git commit -m "$(printf 'feat(mac): wire 2D/3D toggle into UAGraphView\n\nSegmented 2D/3D control in the canvas toolbar; both embed sites (inline +\nexpanded overlay) render Graph3DView when 3D is on, sharing displayData and\nthe selectedNode binding. Per-mode cache of settled 3D positions with a\nbackground settle (superseded-run guard like settlePhysics); cache\ninvalidated when the mode'\''s graph changes.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Self-Review

**1. Spec coverage**
- True 3D force layout → Task 1 (`CGSimulation3D`, carries over all tuning + velocity clamp). ✓
- SceneKit renderer (spheres, batched edges, kind colours, degree sizing) → Task 2. ✓
- Orbit/zoom/pan camera → Task 2 (`allowsCameraControl` + framed camera). ✓
- Click-to-select into existing detail panel → Task 2 (`handleClick` → `selected` binding). ✓
- Label for selected node only → Task 2 (billboard `SCNText`). ✓
- 2D/3D toggle in header, both embed sites → Task 3 (Steps 4–6). ✓
- Per-mode position cache, no re-settle on toggle → Task 3 (Steps 1–3). ✓
- Degenerate-bounds camera guard → Task 2 (`frameCamera` fallback). ✓
- Mid-settle supersede guard → Task 3 (`settle3DIfNeeded`). ✓
- Bounded/finite test → Task 1. ✓
- Reuse `GraphPrune` (already applied to `displayData` upstream for doc/All), `CGPalette`, `CGData`, `selectedNode` → no extra task needed; consumed as-is. ✓
- Out-of-scope items (drag/focus/filter/always-on labels/octree) → not implemented. ✓

**2. Placeholder scan:** No TBD/TODO/"handle edge cases" — every code step is complete. The one judgment note (Task 2 Step 2, `Color`→`NSColor` fallback) names the exact file to check and the concrete fallback. ✓

**3. Type consistency:**
- `CGSimulation3D(data:)`, `settle(maxIterations:threshold:)`, `positions() -> [String: SIMD3<Float>]` — identical across Task 1 (def), Task 1 test, and Task 3 (use). ✓
- `Graph3DView(data:positions:selected:)` — identical in Task 2 (def) and Task 3 Steps 5–6 (use). ✓
- `Graph3DView.radius(forDegree:)` matches `CodeGraphCanvas.nodeR` formula `5 + min(sqrt(deg)*1.4, 24)`. ✓
- `positions3DByMode: [Mode: [String: SIMD3<Float>]]` — same key/value type in declaration, helper, invalidation, and both embed reads. ✓
- `Mode` is `UAGraphView`'s existing mode enum (used as a dictionary key — it is `Hashable` via `String` rawValue; if the compiler complains it isn't `Hashable`, key by `mode.rawValue: String` instead — confirm in Step 7's build).

## Execution Handoff

(Offered after save.)
