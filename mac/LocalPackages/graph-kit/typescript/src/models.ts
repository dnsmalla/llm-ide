// Canonical GraphKit graph model — the TypeScript mirror of the Swift `CGData`
// types. The on-disk JSON form is identical across languages; see ../../schema/SCHEMA.md
// and ../../schema/graph.schema.json. Runtime validation uses zod.

import { z } from "zod";

/** Bump on a breaking schema change. Mirror of `GraphDocument.currentSchemaVersion`. */
export const CURRENT_SCHEMA_VERSION = 1 as const;

export const NODE_KINDS = [
  "file", "symbol", "module", "function", "classType", "config", "service",
  "table", "endpoint", "pipeline", "schemaNode", "resource", "domain", "flow",
  "step", "docPage", "memoryDoc", "memoryChunk", "noteDecision", "noteTask",
  "noteQuestion", "noteFact", "noteConcept", "notePlaybook", "noteHypothesis",
  "noteEvent", "noteSource", "article", "entity", "topic", "claim",
  "skill", "agent", "other",
] as const;
export type CGNodeKind = (typeof NODE_KINDS)[number];

export const EDGE_KINDS = [
  "imports", "exports", "contains", "defines", "inherits", "implements", "calls",
  "references", "subscribes", "publishes", "middleware", "routes", "readsFrom",
  "writesTo", "transforms", "validates", "migrates", "definesSchema", "dependsOn",
  "testedBy", "configures", "deploys", "serves", "provisions", "triggers",
  "documents", "containsFlow", "flowStep", "crossDomain", "relatedTo", "similarTo",
  "cites", "contradicts", "buildsOn", "exemplifies", "categorizedUnder", "authoredBy",
] as const;
export type CGEdgeKind = (typeof EDGE_KINDS)[number];

export const EDGE_CONFIDENCES = ["EXTRACTED", "INFERRED", "AMBIGUOUS"] as const;
export type CGEdgeConfidence = (typeof EDGE_CONFIDENCES)[number];

export interface CGPosition { x: number; y: number; }

export interface CGNode {
  id: string;
  title: string;
  kind: CGNodeKind;
  /** Layout hint only — carries no semantic meaning. */
  position?: CGPosition;
  metadata: Record<string, string>;
}

export interface CGEdge {
  fromId: string;
  toId: string;
  kind: CGEdgeKind;
  confidence: CGEdgeConfidence;
}

export interface CGLayer { id: string; name: string; nodeIds: string[]; }
export interface CGTourStep { nodeId: string; title: string; body: string; }

export interface CGData {
  nodes: CGNode[];
  edges: CGEdge[];
  layers: CGLayer[];
  tour: CGTourStep[];
}

export interface GraphDocument extends CGData {
  schemaVersion: number;
}

// ---------------------------------------------------------------------------
// zod schemas (runtime validation of untrusted JSON)
// ---------------------------------------------------------------------------

const positionSchema = z.object({ x: z.number(), y: z.number() }).strict();

export const nodeSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    kind: z.enum(NODE_KINDS),
    position: positionSchema.optional(),
    metadata: z.record(z.string(), z.string()).default({}),
  })
  .strict();

export const edgeSchema = z
  .object({
    fromId: z.string().min(1),
    toId: z.string().min(1),
    kind: z.enum(EDGE_KINDS),
    confidence: z.enum(EDGE_CONFIDENCES),
  })
  .strict();

export const layerSchema = z
  .object({ id: z.string(), name: z.string(), nodeIds: z.array(z.string()) })
  .strict();

export const tourStepSchema = z
  .object({ nodeId: z.string(), title: z.string(), body: z.string() })
  .strict();

export const graphDocumentSchema = z
  .object({
    schemaVersion: z.number().int().min(1),
    nodes: z.array(nodeSchema),
    edges: z.array(edgeSchema),
    layers: z.array(layerSchema).default([]),
    tour: z.array(tourStepSchema).default([]),
  })
  .strict();

// ---------------------------------------------------------------------------
// (de)serialize / validate
// ---------------------------------------------------------------------------

export class GraphSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphSchemaError";
  }
}

/** Union two graphs: nodes deduped by id (first wins), edges by (from,to,kind). */
export function mergeGraphs(a: CGData, b: CGData): CGData {
  const nodes = [...a.nodes];
  const haveNode = new Set(nodes.map((n) => n.id));
  for (const n of b.nodes) if (!haveNode.has(n.id)) { haveNode.add(n.id); nodes.push(n); }

  const edges = [...a.edges];
  const haveEdge = new Set(edges.map((e) => `${e.fromId}→${e.toId}:${e.kind}`));
  for (const e of b.edges) {
    const k = `${e.fromId}→${e.toId}:${e.kind}`;
    if (!haveEdge.has(k)) { haveEdge.add(k); edges.push(e); }
  }
  return { nodes, edges, layers: [...a.layers, ...b.layers], tour: [...a.tour, ...b.tour] };
}

/** Wrap a CGData in a versioned GraphDocument. */
export function toDocument(graph: CGData, schemaVersion = CURRENT_SCHEMA_VERSION): GraphDocument {
  return { schemaVersion, ...graph };
}

/** Drop the version envelope. */
export function toGraph(doc: GraphDocument): CGData {
  return { nodes: doc.nodes, edges: doc.edges, layers: doc.layers ?? [], tour: doc.tour ?? [] };
}

/**
 * Validate + parse untrusted JSON into a GraphDocument. Throws GraphSchemaError on
 * a malformed document or an unsupported (future) schema version.
 */
export function parseDocument(json: unknown): GraphDocument {
  const result = graphDocumentSchema.safeParse(json);
  if (!result.success) {
    throw new GraphSchemaError(`invalid graph document: ${result.error.message}`);
  }
  const doc = result.data as GraphDocument;
  if (doc.schemaVersion > CURRENT_SCHEMA_VERSION) {
    throw new GraphSchemaError(
      `unsupported schemaVersion ${doc.schemaVersion} (max ${CURRENT_SCHEMA_VERSION})`,
    );
  }
  return doc;
}

/** Parse from a JSON string. */
export function parseDocumentString(text: string): GraphDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new GraphSchemaError(`not valid JSON: ${(err as Error).message}`);
  }
  return parseDocument(raw);
}

/** Canonical serialization: sorted keys, 2-space indent — stable across producers. */
export function serializeDocument(doc: GraphDocument): string {
  return stableStringify(doc) + "\n";
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, sortedReplacer(), 2);
}

function sortedReplacer() {
  return function (this: unknown, _key: string, val: unknown): unknown {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(val as Record<string, unknown>).sort()) {
        sorted[k] = (val as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return val;
  };
}
