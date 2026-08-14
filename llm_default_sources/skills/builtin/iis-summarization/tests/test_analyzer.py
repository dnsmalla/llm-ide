"""
test_analyzer.py
────────────────
Integration tests for iis_summarization.analyzer. Requires Gurobi.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from _helpers import requires_gurobi

from iis_summarization.analyzer import (
    ITERATION_HARD_CAP,
    ITERATION_INITIAL,
    ITERATION_STEP,
    AnalysisOptions,
    Analyzer,
    run_analysis,
)
from iis_summarization.errors import IISSummarizationError

SKILL_ROOT = Path(__file__).parent.parent
FIXTURES = SKILL_ROOT / "tests" / "fixtures"


@requires_gurobi
class TestAnalyzerRun:
    def test_tiny_end_to_end(self, tmp_path: Path) -> None:
        report_path = run_analysis(
            lp_file=FIXTURES / "tiny_infeasible.lp",
            output_dir=tmp_path,
            iis_timeout=30,
            max_iterations=5,
            feasibility_timeout=15,
        )
        assert report_path.exists()
        text = report_path.read_text(encoding="utf-8")
        assert "# Infeasibility Report —" in text
        # Narrative prose is the summarizer subagent's job — the Python
        # pipeline must emit only the placeholder, never the sections.
        # Exact-line match: the Step 5.5 header legitimately starts with
        # "## Why infeasible…" and must not trip this check.
        for heading in ["## Verdict\n", "## Why\n", "## Fix\n", "## Root Cause\n"]:
            assert heading not in text
        assert "summarizer subagent" in text
        for emoji in ["🚨", "⚠️", "✅", "📊", "🔍", "❌", "📝"]:
            assert emoji not in text

    def test_factory_minimal_pipeline(self, tmp_path: Path) -> None:
        analyzer = Analyzer.create()
        options = AnalysisOptions(
            iis_timeout=30,
            max_iterations=3,
            feasibility_timeout=10,
            skip_minimize=True,
            skip_classify=True,
            skip_grouping=True,
        )
        report_path = analyzer.run(
            lp_file=FIXTURES / "tiny_infeasible.lp",
            output_dir=tmp_path,
            options=options,
        )
        assert report_path.exists()

    def test_missing_file_raises(self, tmp_path: Path) -> None:
        missing = tmp_path / "does_not_exist.lp"
        with pytest.raises(IISSummarizationError):
            run_analysis(
                lp_file=missing,
                output_dir=tmp_path,
                iis_timeout=5,
                max_iterations=2,
                feasibility_timeout=5,
                skip_minimize=True,
                skip_classify=True,
                skip_grouping=True,
            )


class TestStaircaseConstants:
    def test_staircase_constants_are_sensible(self) -> None:
        assert ITERATION_INITIAL == 10
        assert ITERATION_STEP == 10
        assert ITERATION_HARD_CAP == 100
        # Each attempt should append ITERATION_STEP iterations.
        assert ITERATION_HARD_CAP % ITERATION_STEP == 0
        # Hard cap must be at least one full initial budget.
        assert ITERATION_HARD_CAP >= ITERATION_INITIAL

    def test_default_options_enable_staircase(self) -> None:
        # max_iterations=0 (default) means "use staircase extender".
        assert AnalysisOptions().max_iterations == 0
