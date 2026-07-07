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
 */
export type GraphNodeKind =
  | 'codeFile'
  | 'codeSymbol'
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
 */
export type GraphEdgeKind =
  | 'imports'
  | 'references'
  | 'partOf'
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
