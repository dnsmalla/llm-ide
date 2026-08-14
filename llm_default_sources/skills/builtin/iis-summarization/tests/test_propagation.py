"""
test_propagation.py
───────────────────
Tests for Step 5.5 — feasibility-based bound tightening (the value
trace). The arithmetic core (propagate_rows) is solver-free and tested
with hand-built rows; the Gurobi shim and report rendering are covered
end-to-end on the tiny fixture.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from _helpers import requires_gurobi

from iis_summarization.propagation import Domain, Row, propagate_rows

SKILL_ROOT = Path(__file__).parent.parent
FIXTURES = SKILL_ROOT / "tests" / "fixtures"


class TestPureCore:
    def test_two_constraint_conflict_reaches_contradiction(self) -> None:
        """x + y >= 10 and x + y <= 5 with x, y in [0, 5] must end in an
        empty domain — the exact numeric 'why'."""
        rows = [
            Row(name="demand_min", terms={"x": 1.0, "y": 1.0}, sense=">=", rhs=10.0),
            Row(name="capacity_max", terms={"x": 1.0, "y": 1.0}, sense="<=", rhs=5.0),
        ]
        domains = {
            "x": Domain(lb=0.0, ub=5.0),
            "y": Domain(lb=0.0, ub=5.0),
        }
        result = propagate_rows(rows, domains)
        assert result.reached_contradiction is True
        assert result.contradiction is not None
        assert result.steps  # the forcing chain is recorded

    def test_feasible_rows_reach_fixed_point(self) -> None:
        rows = [Row(name="c", terms={"x": 1.0}, sense="<=", rhs=10.0)]
        domains = {"x": Domain(lb=0.0, ub=5.0)}
        result = propagate_rows(rows, domains)
        assert result.reached_contradiction is False

    def test_japanese_contradiction_text(self) -> None:
        rows = [
            Row(name="hi", terms={"x": 1.0}, sense=">=", rhs=10.0),
            Row(name="lo", terms={"x": 1.0}, sense="<=", rhs=5.0),
        ]
        domains = {"x": Domain(lb=0.0, ub=100.0)}
        result = propagate_rows(rows, domains, language="ja")
        assert result.reached_contradiction is True
        assert "実行可能な値が存在しません" in result.contradiction.detail


@requires_gurobi
class TestEndToEnd:
    def test_value_trace_in_report(self, tmp_path: Path) -> None:
        """The full pipeline renders the forcing chain as a top-level
        report section when propagation isolates the contradiction."""
        from iis_summarization.analyzer import run_analysis

        report = run_analysis(
            lp_file=FIXTURES / "tiny_infeasible.lp",
            output_dir=tmp_path,
            iis_timeout=30,
            feasibility_timeout=15,
        )
        text = report.read_text()
        assert "value trace" in text.lower()
        assert "Contradiction" in text

    def test_value_trace_japanese(self, tmp_path: Path) -> None:
        from iis_summarization.analyzer import AnalysisOptions, Analyzer

        report = Analyzer.create().run(
            lp_file=FIXTURES / "tiny_infeasible.lp",
            output_dir=tmp_path,
            options=AnalysisOptions(
                iis_timeout=30, feasibility_timeout=15, language="ja"
            ),
        )
        text = report.read_text()
        assert "値のトレース" in text
        assert "矛盾" in text
