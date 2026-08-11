-- Provenance for the code graph. Two producers now write these tables:
--
--   'scip'      — connectors/scip.mjs, from a Sourcegraph SCIP index.
--   'structure' — connectors/structure-graph.mjs, from the Mac app's
--                 StructureGraphBuilder output (git ls-files + per-language
--                 parsing), POSTed to /kb/ingest-code-graph after each
--                 knowledge-graph generation.
--
-- Without this column a `replace` from either producer wiped the other's rows
-- for the same repo — and the Mac app re-generates every few minutes, so a
-- user's SCIP graph would silently vanish. `clearCodeGraph` now scopes its
-- delete by source, so each producer only replaces what it wrote.
--
-- Deliberately NOT part of the primary key: the two id schemes are structurally
-- different ('file:kb/db.mjs' / 'function:kb/db.mjs:foo' vs a SCIP moniker), so
-- a cross-producer symbol_id collision is not a realistic case, and changing a
-- SQLite PRIMARY KEY requires a full table rebuild. If both producers ever do
-- emit the same symbol_id, INSERT OR IGNORE keeps whichever landed first.

ALTER TABLE code_graph_nodes ADD COLUMN source TEXT NOT NULL DEFAULT 'scip';
ALTER TABLE code_graph_edges ADD COLUMN source TEXT NOT NULL DEFAULT 'scip';

CREATE INDEX IF NOT EXISTS idx_cgn_user_repo_source ON code_graph_nodes (user_id, repo_id, source);
CREATE INDEX IF NOT EXISTS idx_cge_user_repo_source ON code_graph_edges (user_id, repo_id, source);
