---
title: LLM IDE — Engineering Documentation
maintainer: TBD
---

# LLM IDE — Engineering Documentation

Internal engineering documentation. End-user docs and customer/admin docs live elsewhere (planned).

## Start here

- New to the project? → [Record your first meeting](tutorials/01-first-meeting.md)
- Looking for the API? → [API overview](reference/api/overview.md)
- About to change a hot path? → [Engineering invariants](explanation/invariants.md)
- Wondering why X is the way it is? → [Decisions](decisions/)

## How this site is organised

We follow the [Diátaxis](https://diataxis.fr/) framework — every page is one of four types.

| Section | When you're … |
|---|---|
| [Tutorials](tutorials/) | Learning the system end-to-end |
| [How-to](how-to/) | Solving a specific task with a known goal |
| [Reference](reference/) | Looking something up |
| [Explanation](explanation/) | Trying to understand *why* |
| [Runbooks](runbooks/) | The server is on fire and you need to fix it now |
| [Decisions](decisions/) | (extra) Reading the formal ADR for a design choice |

If you write a new page, copy a template from `docs/_templates/` and place it in the matching folder.

## Two reading depths

- **Explanation** (`explanation/`) — understand, navigate, port, and safely change the system.
- **Spec** (`spec/`) — rebuild-grade contracts. Read these when reproducing a subsystem exactly.
