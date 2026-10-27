# Kits

A **kit** is one capability of LLM-IDE that can be read, tested, removed and
(later) rebuilt on its own: its server routes, its Mac feature folder and the
Core code behind it, its extension surface, its contract group and its feature
key. The kit-by-kit migration plan (`docs/superpowers/plans/2026-10-27-kit-by-kit-migration.md`)
moves one kit at a time through the same steps; the **K0 Map** step produces
the kit README. A kit README records, with `path:line` evidence, the code on
every side, every edge into and out of the kit, which pieces are *delegated* to
the model or Agent SDK (thin adapters) and which are *owned* by LLM-IDE
(project control), the kit's state, and the proposed K1 move. It is a map, not
a design: it changes no code, and it is revised as each later step lands.

| Kit | Key | Status | README |
|---|---|---|---|
| docs-kit (Doc Gen, Visual, `/generate-doc(x)`) | `doc_gen` | K0 map | [docs-kit.md](docs-kit.md) |
| graph-kit (Code Graph, OS view, graph engine plugin) | `code_graph_3d` | K0 map | [graph-kit.md](graph-kit.md) |
