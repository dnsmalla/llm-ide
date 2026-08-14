"""
test_batch_refiner.py
─────────────────────
Tests for iis_summarization.batch_refiner.

Unit tests exercise the _order_batch helper and edge-case branches
(empty batch, single-element batch). End-to-end add-back isolation
requires Gurobi and is guarded by `requires_gurobi`.
"""

from __future__ import annotations

from collections import Counter
from pathlib import Path

import pytest
from _helpers import requires_gurobi

from iis_summarization.batch_refiner import BatchRefiner, _order_batch, refine_batch
from iis_summarization.ilp_parser import parse_ilp
from iis_summarization.models import BatchRefinementResult, ParsedILP

SKILL_ROOT = Path(__file__).parent.parent
FIXTURES = SKILL_ROOT / "tests" / "fixtures"


@pytest.fixture()
def parsed() -> ParsedILP:
    p = ParsedILP()
    p.constraints = {"a": "x >= 1", "b": "y >= 1", "c": "z >= 1"}
    p.variable_refs = Counter({"a": 10, "b": 5, "c": 2})
    return p


class TestOrderBatch:
    def test_sorted_by_variable_refs_descending(self, parsed: ParsedILP) -> None:
        assert _order_batch(["c", "a", "b"], parsed) == ["a", "b", "c"]

    def test_missing_names_treated_as_zero(self, parsed: ParsedILP) -> None:
        ordered = _order_batch(["a", "z"], parsed)
        assert ordered[0] == "a"  # higher ref count comes first
        assert ordered[-1] == "z"  # unknown -> 0 -> last

    def test_empty_batch(self, parsed: ParsedILP) -> None:
        assert _order_batch([], parsed) == []


class TestEmptyBatch:
    def test_returns_failure(self, tmp_path: Path, parsed: ParsedILP) -> None:
        result = refine_batch(
            base_lp_file=FIXTURES / "tiny_infeasible.lp",
            batch=[],
            parsed_ilp=parsed,
            work_dir=tmp_path,
            feasibility_timeout=5,
        )
        assert result.success is False
        assert "Empty batch" in result.error_message


class TestSingleConstraintBatch:
    def test_returns_that_constraint_as_root(self, tmp_path: Path, parsed: ParsedILP) -> None:
        result = refine_batch(
            base_lp_file=FIXTURES / "tiny_infeasible.lp",
            batch=["demand_min"],
            parsed_ilp=parsed,
            work_dir=tmp_path,
            feasibility_timeout=5,
        )
        assert result.success is True
        assert result.root_cause == "demand_min"
        assert result.add_back_trace == []


class TestFactoryInterface:
    def test_create_returns_refiner(self) -> None:
        refiner = BatchRefiner.create()
        assert isinstance(refiner, BatchRefiner)


@requires_gurobi
class TestAddBackIsolation:
    """End-to-end: on tiny_infeasible.lp the batch {demand_min, capacity_max}
    should isolate down to a single root cause."""

    def test_isolates_root_cause(self, tmp_path: Path) -> None:
        parsed_ilp = parse_ilp(FIXTURES / "tiny_infeasible_iis.ilp")
        batch = ["demand_min", "capacity_max"]
        result: BatchRefinementResult = refine_batch(
            base_lp_file=FIXTURES / "tiny_infeasible.lp",
            batch=batch,
            parsed_ilp=parsed_ilp,
            work_dir=tmp_path,
            feasibility_timeout=10,
        )
        assert result.success is True
        # Either constraint alone is feasible with the other removed;
        # adding the second should flip it to infeasible.
        assert result.root_cause in batch
        assert len(result.add_back_trace) >= 1
        # Final trace step must be the infeasible one
        assert result.add_back_trace[-1].is_feasible is False
