# 3D Graph Display — Design Spec

**Date:** 2026-06-24
**Status:** Approved (brainstorm) — ready for implementation plan
**Component:** Mac app (`mac/`), graph rendering

## Goal

Add an optional 3D rendering of the knowledge/code graph (Code Graph /
InfiniteBrain / All) alongside the existing 2D `CodeGraphCanvas`, switchable
with a `2D / 3D` toggle. The 3D view is for **visual exploration** — orbit,
zoom, pan, and click-to-select — not a full reimplementation of every 2D
interaction.

## Scope

**In scope (v1):**
- True 3D force-directed layout (nodes positioned in real 3D space).
- SceneKit-based renderer: spheres for nodes (kind-colored, degree-sized),
  batched line geometry for edges.
- Orbit / zoom / pan camera.
- Click a node to select it → drives the **existing** detail panel via the
  shared `selectedNode` binding.
- A label shown for the hovered/selected node only.
- A `2D / 3D` toggle in the graph header; works in both the inline and
  expanded (fullscreen) embed sites.
- 3D positions cached per mode so toggling does not re-settle.

**Out of scope (v1), explicitly deferred:**
- Drag-to-reposition nodes in 3D.
- Double-click focus mode (dim non-neighbours).
- Kind filter / highlight-by-kind.
- Always-on labels for every node.
- Octree/Barnes-Hut for the 3D sim (not needed at current node counts).

## Constraints

- **Node counts:** Code Graph ~720, InfiniteBrain ~300 (post-dedup), All
  ~1,600. The 3D sim and renderer must be smooth at ≤~1,600 nodes / ~6k edges.
- **No new third-party dependencies.** SceneKit is part of the macOS SDK.
- **Reuse, don't fork:** `CGData`, `GraphPrune`, `CGPalette`, and the
  `selectedNode` binding are shared with the 2D path unchanged.
- **Build/CI:** `swift build` verifies; `swift test` for the Mac target is
  blocked by the Testing.framework SDK/compiler skew, so Mac-side tests are
  authored + `swift build`-checked but not run locally (push `--no-verify`).
  The 3D **sim** is pure logic and is the part covered by a test.

## Architecture

Three units, each with a single responsibility:

### 1. `CGSimulation3D` — 3D force layout
*New file: `mac/Sources/LlmIdeMac/CodeGraph/CGSimulation3D.swift`*

A 3D analogue of `CGSimulation`. Positions and velocities are `SIMD3<Float>`
(adds a Z axis to the existing 2D model). It carries over the tuning validated
for the 2D sim:
- spring attraction along edges (`kAttraction`, `restLength`),
- repulsion between nodes,
- centering toward the origin,
- **per-node velocity clamp** (prevents the dense-graph divergence fixed in the
  2D sim),
- golden-angle (now spherical, e.g. Fibonacci-sphere) initial jitter so
  superimposed nodes have a direction to separate along.

Repulsion is plain **O(n²)** per tick (no octree): at ≤1,600 nodes × ~150
iterations this settles in ~1–2s in a background `Task.detached`, matching the
2D settle pattern. (An octree is a documented future optimization, not v1.)

Public surface:
```swift
final class CGSimulation3D {
    init(data: CGData)                                  // reads CGData.nodes/edges
    func settle(maxIterations: Int, threshold: Float)   // off-main-actor
    func positions() -> [String: SIMD3<Float>]          // id -> settled position
}
```

The view caller applies `GraphPrune.capDegree(...)` to the doc/All graph before
constructing the sim, exactly as the 2D paths do.

### 2. `Graph3DView` — SceneKit renderer
*New file: `mac/Sources/LlmIdeMac/Views/CodeGraph/Graph3DView.swift`*

A SwiftUI `NSViewRepresentable` wrapping an `SCNView`. Inputs: `data: CGData`,
the settled `[String: SIMD3<Float>]` positions, and a `@Binding var selected:
CGNode?`.

- **Nodes:** one `SCNNode` per graph node, geometry a shared `SCNSphere`
  scaled by degree (reusing the 2D radius formula, capped), material colour from
  `CGPalette.color(for: node.kind)`.
- **Edges:** a single batched `SCNGeometry` built from a line-primitive vertex
  buffer (one draw call for all edges), low-opacity neutral colour.
- **Camera:** `allowsCameraControl = true` for orbit/zoom/pan; camera framed to
  the bounding sphere of the layout on first load.
- **Selection:** a click gesture runs `SCNView.hitTest`; the nearest hit node
  maps back to its `CGNode` and sets `selected` (the same binding the 2D canvas
  and detail panel already use).
- **Label:** the hovered/selected node's title is shown via a SwiftUI overlay
  positioned with `SCNView.projectPoint`, or an `SCNText` billboard — chosen
  during implementation, whichever reads more cleanly.

The Coordinator holds an `id -> SCNNode` map for hit-testing and incremental
updates; rebuilding the scene only when `data`/positions change.

### 3. `UAGraphView` integration
*Edit: `mac/Sources/LlmIdeMac/Views/CodeGraph/UAGraphView.swift`*

- New `@State private var render3D = false`.
- A `2D / 3D` segmented control beside the existing Labels/Symbols toggles in
  the header.
- Both embed sites (inline graph area and `expandedGraphOverlay`) render
  `Graph3DView` when `render3D` is on, else `CodeGraphCanvas`. Both receive the
  same `displayData` and `$selectedNode`.
- A per-mode cache of settled 3D positions (`[Mode: [String: SIMD3<Float>]]`)
  so flipping 2D⇄3D or revisiting a mode does not re-run the 3D settle. The
  settle kicks off on first switch-to-3D for a mode whose positions aren't
  cached, in a background task with the same superseded-run guard as
  `settlePhysics`.

## Data flow

```
displayData (already pruned + kind-filtered by recomputeDisplayData)
   └─(on first 3D switch for this mode)→ GraphPrune already applied upstream
       └→ CGSimulation3D(data:).settle()           [background]
           └→ positions: [id: SIMD3<Float>]  (cached per mode)
               └→ Graph3DView builds SCNScene
                   └→ click → hitTest → selected (shared binding) → detail panel
```

## Error / edge handling

- Empty or single-node graph: render nothing / a single centred sphere; no
  crash, no camera NaN.
- Non-finite positions: the velocity clamp makes divergence impossible, but the
  camera-framing step still guards against a degenerate/zero bounding sphere
  (fall back to a fixed camera distance), mirroring the 2D `fit` guard.
- Mode/graph change mid-settle: the superseded-run guard drops stale results
  (same pattern as `settlePhysics`).

## Testing

- **`CGSimulation3DTests`** (`mac/Tests/LlmIdeMacTests/`): a dense hub graph
  settles to **bounded, finite** 3D positions (the divergence guard), mirroring
  `CGSimulationTests`. Pure logic — the part worth a test.
- **`Graph3DView`**: verified visually via screenshots during implementation
  (SceneKit views aren't unit-testable here). `swift build` confirms it
  compiles.
- Note: `swift test` for the Mac target can't run locally (toolchain skew);
  tests are authored and build-checked, run when the toolchain is fixed.

## Future (not v1)

- Barnes-Hut octree for the 3D sim if node counts grow well beyond ~1,600.
- Drag-to-reposition, focus mode, kind filter, always-on labels in 3D.
- Animated transition between 2D and 3D layouts.
