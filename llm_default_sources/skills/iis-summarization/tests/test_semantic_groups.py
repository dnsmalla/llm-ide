"""
test_semantic_groups.py
───────────────────────
Tests for iis_summarization.semantic_groups. Requires Gurobi for the
end-to-end path; union-find internals are covered without gurobipy.
"""

from __future__ import annotations

from pathlib import Path

from _helpers import requires_gurobi

from iis_summarization.semantic_groups import (
    SemanticGrouper,
    _UnionFind,
    group_by_shared_variables,
)

SKILL_ROOT = Path(__file__).parent.parent
FIXTURES = SKILL_ROOT / "tests" / "fixtures"


class TestUnionFind:
    """Unit tests for the weighted quick-union helper."""

    def test_singletons(self) -> None:
        uf = _UnionFind(["a", "b", "c"])
        comps = uf.components()
        assert len(comps) == 3

    def test_single_union(self) -> None:
        uf = _UnionFind(["a", "b", "c"])
        uf.union("a", "b")
        comps = uf.components()
        assert len(comps) == 2

    def test_chain_union_forms_one_component(self) -> None:
        uf = _UnionFind(["a", "b", "c", "d"])
        uf.union("a", "b")
        uf.union("b", "c")
        uf.union("c", "d")
        assert len(uf.components()) == 1

    def test_find_returns_same_root_after_union(self) -> None:
        uf = _UnionFind(["a", "b"])
        uf.union("a", "b")
        assert uf.find("a") == uf.find("b")

    def test_add_noop_for_existing(self) -> None:
        uf = _UnionFind(["a"])
        uf.add("a")
        assert len(uf.components()) == 1

    def test_add_new_item(self) -> None:
        uf = _UnionFind(["a"])
        uf.add("b")
        assert len(uf.components()) == 2


@requires_gurobi
class TestGroupByVariables:
    def test_tiny_forms_single_group(self) -> None:
        result = group_by_shared_variables(
            lp_file=FIXTURES / "tiny_infeasible.lp",
            iis_constraint_names=["demand_min", "capacity_max"],
        )
        assert result.success is True
        assert result.group_count == 1
        assert result.groups[0].size == 2

    def test_empty_input_succeeds(self) -> None:
        result = group_by_shared_variables(
            lp_file=FIXTURES / "tiny_infeasible.lp",
            iis_constraint_names=[],
        )
        assert result.success is True
        assert result.group_count == 0

    def test_factory_interface_works(self) -> None:
        grouper = SemanticGrouper.create()
        result = grouper.group(
            lp_file=FIXTURES / "tiny_infeasible.lp",
            iis_constraint_names=["demand_min", "capacity_max"],
        )
        assert result.success is True


@requires_gurobi
class TestSharedModelGrouping:
    def test_group_accepts_preloaded_model(self) -> None:
        """group(model=...) reuses the shared model and must not dispose it."""
        import gurobipy as gp

        shared = gp.read(str(FIXTURES / "tiny_infeasible.lp"))
        try:
            grouper = SemanticGrouper.create()
            result = grouper.group(
                lp_file=FIXTURES / "tiny_infeasible.lp",
                iis_constraint_names=["demand_min", "capacity_max"],
                model=shared,
            )
            assert result.success is True
            assert result.group_count == 1
            # The shared model must still be usable after group().
            assert shared.NumConstrs == 4
        finally:
            shared.dispose()
