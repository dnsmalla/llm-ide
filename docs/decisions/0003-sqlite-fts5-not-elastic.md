---
title: "0003. Use SQLite with FTS5 instead of Postgres or Elasticsearch"
status: accepted
date: 2026-05-18
---

# 0003. Use SQLite with FTS5 instead of Postgres or Elasticsearch

## Context

The knowledge base needs unified full-text search across meetings, entities, sources, plans, tickets, and outcomes. The product is local-first, single-process. Postgres + a search index (Elastic, Tantivy, Meilisearch) was the obvious alternative.

## Decision

Use `better-sqlite3` with WAL mode and FTS5 in a single file (`kb/data.db`). FTS5 is a virtual table that mirrors the searchable columns of all KB tables; per-tenant filtering is applied at hydration time.

## Consequences

- **Positive:** zero infrastructure; the database is a file the user owns.
- **Positive:** transactions span the data tables and the search index atomically.
- **Positive:** FTS5 is fast enough for KB sizes we expect (≤ 10 GB).
- **Negative:** cross-tenant FTS hits exist in the index and must be filtered on hydration; the tenancy contract enforces this.
- **Negative:** single-writer model; concurrent meeting ingest is serialised. Not a problem at single-user scale.
- **Locked in:** see [explanation/architecture.md](../explanation/architecture.md).
