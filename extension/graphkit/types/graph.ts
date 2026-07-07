/**
 * Unified graph data structure.
 */
export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/**
 * A node in the code/doc graph.
 */
export interface GraphNode {
  id: string;
  title: string;
  kind: GraphNodeKind;
  metadata?: Record<string, unknown>;
}

/**
 * Node kinds in the graph.
 *
 * Must stay in lock-step with GraphKit's canonical `CGNodeKind` Swift enum
 * (mac/.build/checkouts/graph-kit/.../CodeGraphModels.swift). The Swift
 * `Codable` decoder throws on unknown raw values, so TS writers must emit
 * these exact strings.
 */
export type GraphNodeKind =
  | 'file'
  | 'symbol'
  | 'docPage'
  | 'memoryChunk'
  | 'memoryDoc';

/**
 * An edge between nodes.
 */
export interface GraphEdge {
  fromId: string;
  toId: string;
  kind: GraphEdgeKind;
}

/**
 * Edge kinds.
 *
 * Must stay in lock-step with GraphKit's canonical `CGEdgeKind` Swift enum
 * (mac/.build/checkouts/graph-kit/.../CodeGraphModels.swift). The Swift
 * `Codable` decoder throws on unknown raw values, so TS writers must emit
 * these exact strings. Note there is no `partOf` — use `contains` for
 * ownership/containment relationships.
 */
export type GraphEdgeKind =
  | 'imports'
  | 'references'
  | 'contains'
  | 'relatedTo';

/**
 * Generation mode for graphs.
 */
export type GraphMode = 'code' | 'doc' | 'all';

/**
 * A code reference returned by graph queries.
 */
export interface CodeRef {
  ref: string;
  title: string;
  bodyExcerpt: string;
  rank: number;
}
