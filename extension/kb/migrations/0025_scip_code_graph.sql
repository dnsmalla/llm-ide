-- SCIP code-graph store. Nodes/edges from a Sourcegraph SCIP index, written by
-- connectors/scip.mjs indexScip and traversed by kb/code-graph.mjs expandSymbols.
-- Canonical CGData kinds (graph-kit) live in kind; repo_id is the resolved repo
-- path (provenance/snapshot scoping). Traversal is user-scoped by symbol_id, so
-- every row also carries user_id (per the per-user tenancy invariant).

CREATE TABLE IF NOT EXISTS code_graph_nodes (
  user_id     TEXT NOT NULL,
  repo_id     TEXT NOT NULL,
  symbol_id   TEXT NOT NULL,
  title       TEXT NOT NULL,
  kind        TEXT NOT NULL,
  source_file TEXT NOT NULL,
  line        INTEGER NOT NULL,
  language    TEXT,
  doc         TEXT,
  PRIMARY KEY (user_id, repo_id, symbol_id)
);
CREATE INDEX IF NOT EXISTS idx_cgn_user_title ON code_graph_nodes (user_id, title);
CREATE INDEX IF NOT EXISTS idx_cgn_user_sym   ON code_graph_nodes (user_id, symbol_id);

CREATE TABLE IF NOT EXISTS code_graph_edges (
  user_id     TEXT NOT NULL,
  repo_id     TEXT NOT NULL,
  from_id     TEXT NOT NULL,
  to_id       TEXT NOT NULL,
  kind        TEXT NOT NULL,
  confidence  TEXT NOT NULL DEFAULT 'EXTRACTED',
  PRIMARY KEY (user_id, repo_id, from_id, to_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_cge_user_from ON code_graph_edges (user_id, from_id);
CREATE INDEX IF NOT EXISTS idx_cge_user_to   ON code_graph_edges (user_id, to_id);
