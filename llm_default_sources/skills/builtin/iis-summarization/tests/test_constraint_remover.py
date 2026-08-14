"""
test_constraint_remover.py
──────────────────────────
Tests for iis_summarization.constraint_remover. The iterative_removal
end-to-end tests require a working Gurobi installation and are skipped
when ``gurobipy`` is not importable.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from _helpers import requires_gurobi

from iis_summarization.constraint_remover import (
    ConstraintRemover,
    create_modified_lp,
    iterative_removal,
    select_removal_batch,
)
from iis_summarization.ilp_parser import parse_ilp
from iis_summarization.models import RemovalResult

SKILL_ROOT = Path(__file__).parent.parent
FIXTURES = SKILL_ROOT / "tests" / "fixtures"


class TestCreateModifiedLP:
    def test_removes_named_constraint(self, tmp_path: Path) -> None:
        out = tmp_path / "modified.lp"
        ok = create_modified_lp(
            FIXTURES / "tiny_infeasible.lp",
            ["demand_min"],
            out,
        )
        assert ok is True
        assert out.exists()
        assert "demand_min" not in out.read_text()

    def test_retains_other_constraints(self, tmp_path: Path) -> None:
        out = tmp_path / "modified.lp"
        create_modified_lp(
            FIXTURES / "tiny_infeasible.lp",
            ["demand_min"],
            out,
        )
        assert "capacity_max" in out.read_text()

    def test_removes_multiple_constraints(self, tmp_path: Path) -> None:
        out = tmp_path / "modified.lp"
        to_remove = ["shift_morning", "shift_afternoon"]
        ok = create_modified_lp(
            FIXTURES / "scheduling_infeasible.lp",
            to_remove,
            out,
        )
        assert ok is True
        content = out.read_text()
        for name in to_remove:
            assert name not in content

    def test_empty_removal_list_copies_file(self, tmp_path: Path) -> None:
        src = FIXTURES / "tiny_infeasible.lp"
        out = tmp_path / "copy.lp"
        ok = create_modified_lp(src, [], out)
        assert ok is True
        assert out.read_text() == src.read_text()

    def test_output_dir_created_if_missing(self, tmp_path: Path) -> None:
        out = tmp_path / "deep" / "nested" / "out.lp"
        ok = create_modified_lp(
            FIXTURES / "tiny_infeasible.lp",
            ["demand_min"],
            out,
        )
        assert ok is True
        assert out.exists()

    def test_bounds_section_preserved(self, tmp_path: Path) -> None:
        out = tmp_path / "modified.lp"
        create_modified_lp(
            FIXTURES / "tiny_infeasible.lp",
            ["demand_min"],
            out,
        )
        assert "Bounds" in out.read_text()


class TestSelectRemovalBatch:
    @pytest.fixture(autouse=True)
    def parsed_scheduling(self) -> None:
        self.parsed = parse_ilp(FIXTURES / "scheduling_infeasible_iis.ilp")

    def test_batch_size_is_fraction_of_total(self) -> None:
        batch = select_removal_batch(self.parsed, [], batch_fraction=0.25)
        expected = max(1, int(self.parsed.constraint_count * 0.25))
        assert len(batch) == expected

    def test_batch_respects_already_removed(self) -> None:
        first = select_removal_batch(self.parsed, [], batch_fraction=0.25)
        second = select_removal_batch(self.parsed, first, batch_fraction=0.25)
        assert set(first).isdisjoint(set(second))

    def test_returns_empty_when_all_removed(self) -> None:
        all_names = list(self.parsed.constraints.keys())
        assert select_removal_batch(self.parsed, all_names, 0.25) == []

    def test_minimum_batch_size_is_one(self) -> None:
        batch = select_removal_batch(self.parsed, [], batch_fraction=0.001)
        assert len(batch) >= 1

    def test_batch_contains_highest_frequency_constraint(self) -> None:
        top_name, _ = self.parsed.top_constraints(1)[0]
        batch = select_removal_batch(self.parsed, [], batch_fraction=0.25)
        assert top_name in batch


@requires_gurobi
class TestIterativeRemoval:
    """End-to-end removal tests. Require Gurobi."""

    def test_tiny_model_becomes_feasible(self, tmp_path: Path) -> None:
        parsed = parse_ilp(FIXTURES / "tiny_infeasible_iis.ilp")
        result = iterative_removal(
            base_lp_file=FIXTURES / "tiny_infeasible.lp",
            parsed_ilp=parsed,
            work_dir=tmp_path / "iters",
            max_iterations=5,
            batch_fraction=0.50,
            feasibility_timeout=15,
        )
        assert isinstance(result, RemovalResult)
        assert result.success is True
        assert result.iterations_performed >= 1
        assert len(result.culprit_constraints) >= 1
        assert result.feasible_model_file is not None
        assert Path(result.feasible_model_file).exists()

    def test_factory_interface_works(self, tmp_path: Path) -> None:
        parsed = parse_ilp(FIXTURES / "tiny_infeasible_iis.ilp")
        result = ConstraintRemover.create().run(
            base_lp_file=FIXTURES / "tiny_infeasible.lp",
            parsed_ilp=parsed,
            work_dir=tmp_path / "iters",
            max_iterations=5,
            batch_fraction=0.50,
            feasibility_timeout=15,
        )
        assert result.success is True

    def test_culprit_constraints_subset_of_all_removed(self, tmp_path: Path) -> None:
        parsed = parse_ilp(FIXTURES / "tiny_infeasible_iis.ilp")
        result = iterative_removal(
            base_lp_file=FIXTURES / "tiny_infeasible.lp",
            parsed_ilp=parsed,
            work_dir=tmp_path / "iters",
            max_iterations=5,
            batch_fraction=0.50,
            feasibility_timeout=15,
        )
        assert set(result.culprit_constraints).issubset(set(result.all_removed_constraints))
