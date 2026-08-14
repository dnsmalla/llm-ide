"""
semantic_groups.py
──────────────────
Step 6 of the IIS analysis pipeline.

Groups IIS constraints into "conflict subsystems" connected by shared
variables. On a sprawling IIS this turns a flat list of N constraints
into K disjoint clusters, each of which can be debugged independently.

Algorithm
─────────
    Build a constraint ↔ variable incidence structure and merge
    constraints with shared variables via weighted quick-union with
    path compression. Each connected component becomes one
    :class:`ConflictGroup`.
"""

from __future__ import annotations

import contextlib
import logging
from pathlib import Path
from typing import Any

from iis_summarization._gurobi import import_gurobi
from iis_summarization.errors import GurobiUnavailableError
from iis_summarization.interfaces import ISemanticGrouper
from iis_summarization.models import ConflictGroup, SemanticGroupResult

logger = logging.getLogger(__name__)


class _UnionFind:
    """Weighted quick-union with path compression over string items."""

    def __init__(self, items: list[str]) -> None:
        self._parent: dict[str, str] = {x: x for x in items}
        self._size: dict[str, int] = dict.fromkeys(items, 1)

    def add(self, item: str) -> None:
        if item not in self._parent:
            self._parent[item] = item
            self._size[item] = 1

    def find(self, x: str) -> str:
        root = x
        while self._parent[root] != root:
            root = self._parent[root]
        while self._parent[x] != root:
            self._parent[x], x = root, self._parent[x]
        return root

    def union(self, a: str, b: str) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra == rb:
            return
        if self._size[ra] < self._size[rb]:
            ra, rb = rb, ra
        self._parent[rb] = ra
        self._size[ra] += self._size[rb]

    def components(self) -> dict[str, list[str]]:
        groups: dict[str, list[str]] = {}
        for x in self._parent:
            root = self.find(x)
            groups.setdefault(root, []).append(x)
        return groups


class SemanticGrouper(ISemanticGrouper):
    """Default implementation of :class:`ISemanticGrouper`."""

    @classmethod
    def create(cls) -> ISemanticGrouper:
        """Factory returning an :class:`ISemanticGrouper`."""
        return cls()

    def group(
        self,
        lp_file: Path,
        iis_constraint_names: list[str],
        model: Any | None = None,
    ) -> SemanticGroupResult:
        return _group_impl(lp_file, iis_constraint_names, model)


def group_by_shared_variables(
    lp_file: str | Path,
    iis_constraint_names: list[str],
    model: Any | None = None,
) -> SemanticGroupResult:
    """Functional convenience wrapper around :class:`SemanticGrouper`."""
    return SemanticGrouper.create().group(
        lp_file=Path(lp_file),
        iis_constraint_names=list(iis_constraint_names),
        model=model,
    )


def _group_impl(
    lp_file: Path,
    iis_constraint_names: list[str],
    shared_model: Any | None = None,
) -> SemanticGroupResult:
    result = SemanticGroupResult(success=False)

    if not iis_constraint_names:
        result.success = True
        return result

    try:
        gp, _ = import_gurobi()
    except GurobiUnavailableError as exc:
        result.error_message = str(exc)
        return result

    # A model passed in by the orchestrator is borrowed, not owned —
    # never dispose it here.
    owns_model = shared_model is None
    model = None
    try:
        if shared_model is not None:
            model = shared_model
        else:
            model = gp.read(str(lp_file))
            model.setParam("OutputFlag", 0)
        model.update()

        target = set(iis_constraint_names)

        constr_to_vars: dict[str, set[str]] = {}
        for c in model.getConstrs():
            if c.ConstrName not in target:
                continue
            row = model.getRow(c)
            vars_in_c = {
                row.getVar(i).VarName for i in range(row.size()) if abs(row.getCoeff(i)) > 1e-12
            }
            constr_to_vars[c.ConstrName] = vars_in_c

        uf = _UnionFind(list(constr_to_vars.keys()))

        var_to_constrs: dict[str, list[str]] = {}
        for cname, vars_in_c in constr_to_vars.items():
            for v in vars_in_c:
                var_to_constrs.setdefault(v, []).append(cname)

        for cnames in var_to_constrs.values():
            if len(cnames) > 1:
                anchor = cnames[0]
                for other in cnames[1:]:
                    uf.union(anchor, other)

        components = uf.components()
        groups: list[ConflictGroup] = []
        ordered = sorted(components.items(), key=lambda kv: -len(kv[1]))
        for i, (_, members) in enumerate(ordered, start=1):
            var_union: set[str] = set()
            for m in members:
                var_union |= constr_to_vars[m]
            groups.append(
                ConflictGroup(
                    group_id=i,
                    constraints=sorted(members),
                    variables=sorted(var_union),
                )
            )

        result.groups = groups
        result.success = True
        return result

    except gp.GurobiError as exc:
        logger.exception("Gurobi error during semantic grouping")
        result.error_message = f"Gurobi error: {exc}"
        return result
    except (FileNotFoundError, OSError) as exc:
        logger.exception("I/O error during semantic grouping")
        result.error_message = f"I/O error: {exc}"
        return result
    finally:
        if owns_model and model is not None:
            with contextlib.suppress(AttributeError, gp.GurobiError):
                model.dispose()
