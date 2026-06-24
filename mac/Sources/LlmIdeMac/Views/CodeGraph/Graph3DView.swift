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
