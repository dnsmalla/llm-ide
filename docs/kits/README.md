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
| knowledge-kit (Library, KB sources and search, connectors, ReviewConflicts) | none (always on) | K0 map | [knowledge-kit.md](knowledge-kit.md) |
| agent-kit (Chat, ClaudeLink, llm_agent, providers, plugins, MCP, LLM sources, agent history) | `agent_chat` (never off) | K0 map | [agent-kit.md](agent-kit.md) |

Cross-kit principle (user decision 2026-10-29): [data-lifecycle.md](data-lifecycle.md) - one stored copy of each kind of data, live in the server DB while a session runs; a normal chat is archived into the Mac app at app quit and kept until the user deletes it, a meeting-attached chat is deleted at meeting end, and a rebuildable index with no unique data may stay on the server. The web and the extension are connectors with no data access of their own (the extension reads by calling the Mac app live). It applies to knowledge-kit and agent-kit (K1a) and is the reference for every kit's data plan.
