"""
test_ilp_parser.py
──────────────────
Unit tests for iis_summarization.ilp_parser.
No Gurobi license required.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from iis_summarization.ilp_parser import ILPParser, parse_ilp
from iis_summarization.models import ParsedILP

SKILL_ROOT = Path(__file__).parent.parent
FIXTURES = SKILL_ROOT / "tests" / "fixtures"


def fixture(name: str) -> Path:
    return FIXTURES / name


class TestTinyILP:
    """Tests against the minimal 2-constraint ILP fixture."""

    @pytest.fixture(autouse=True)
    def parsed(self) -> None:
        self.result = parse_ilp(fixture("tiny_infeasible_iis.ilp"))

    def test_returns_parsed_ilp_type(self) -> None:
        assert isinstance(self.result, ParsedILP)

    def test_constraint_count(self) -> None:
        assert self.result.constraint_count == 2

    def test_constraint_names_present(self) -> None:
        assert "demand_min" in self.result.constraints
        assert "capacity_max" in self.result.constraints

    def test_demand_min_body_contains_geq(self) -> None:
        assert ">=" in self.result.constraints["demand_min"]

    def test_capacity_max_body_contains_leq(self) -> None:
        assert "<=" in self.result.constraints["capacity_max"]

    def test_variable_refs_populated(self) -> None:
        assert self.result.variable_refs["demand_min"] > 0
        assert self.result.variable_refs["capacity_max"] > 0

    def test_top_constraints_length(self) -> None:
        assert len(self.result.top_constraints(10)) == 2

    def test_top_constraints_sorted_descending(self) -> None:
        counts = [c for _, c in self.result.top_constraints(10)]
        assert counts == sorted(counts, reverse=True)

    def test_bounds_parsed(self) -> None:
        assert len(self.result.bounds) >= 1

    def test_no_binary_vars(self) -> None:
        assert self.result.binary_vars == []


class TestSchedulingILP:
    """Tests against the 8-constraint scheduling fixture."""

    @pytest.fixture(autouse=True)
    def parsed(self) -> None:
        self.result = parse_ilp(fixture("scheduling_infeasible_iis.ilp"))

    def test_constraint_count(self) -> None:
        assert self.result.constraint_count == 8

    def test_all_expected_constraints_present(self) -> None:
        expected = {
            "shift_morning",
            "shift_afternoon",
            "shift_night",
            "capacity_total",
            "max_w1",
            "max_w2",
            "max_w3",
            "max_w4",
        }
        assert expected.issubset(set(self.result.constraints.keys()))

    def test_shift_constraints_reference_multiple_workers(self) -> None:
        assert self.result.variable_refs["shift_morning"] >= 2

    def test_top_constraints_returns_at_most_requested(self) -> None:
        assert len(self.result.top_constraints(5)) <= 5

    def test_capacity_total_references_four_workers(self) -> None:
        assert self.result.variable_refs["capacity_total"] >= 4

    def test_bounds_contain_all_workers(self) -> None:
        all_bounds = " ".join(self.result.bounds.values())
        for w in ("w1", "w2", "w3", "w4"):
            assert w in all_bounds


class TestEdgeCases:
    def test_file_not_found_raises(self) -> None:
        with pytest.raises(FileNotFoundError):
            parse_ilp(FIXTURES / "does_not_exist.ilp")

    def test_empty_ilp(self, tmp_path: Path) -> None:
        empty = tmp_path / "empty.ilp"
        empty.write_text("\\ empty\nEnd\n")
        result = parse_ilp(empty)
        assert result.constraint_count == 0
        assert result.bounds == {}

    def test_comment_lines_ignored(self, tmp_path: Path) -> None:
        ilp = tmp_path / "comments.ilp"
        ilp.write_text("\\ this is a comment\nSubject To\n\\ another comment\n c1: x >= 1\nEnd\n")
        result = parse_ilp(ilp)
        assert result.constraint_count == 1
        assert "c1" in result.constraints

    def test_multiline_constraint(self, tmp_path: Path) -> None:
        ilp = tmp_path / "multiline.ilp"
        ilp.write_text("Subject To\n long_c: x\n  + y\n  + z >= 5\nEnd\n")
        result = parse_ilp(ilp)
        assert "long_c" in result.constraints
        assert "z" in result.constraints["long_c"]


class TestFactoryInterface:
    """The factory-based API must also work."""

    def test_parser_factory_returns_iilpparser(self) -> None:
        parser = ILPParser.create()
        result = parser.parse(fixture("tiny_infeasible_iis.ilp"))
        assert isinstance(result, ParsedILP)
        assert result.constraint_count == 2
