"""
test_enumeration.py
───────────────────
Tests for iis_summarization.enumeration — multi-IIS discovery.

The overlapping-IIS fixture has two IISes sharing constraint
``need_high``:

    need_high: x >= 10     (in both IISes)
    cap_a:     x <= 5      (IIS 1 = {need_high, cap_a})
    cap_b:     x <= 6      (IIS 2 = {need_high, cap_b})

Remove-and-recompute deletes ``need_high`` after the first IIS, hiding
the second. Relax-and-recompute (Gurobi's recommended pattern) loosens
RHS values instead, so the overlapping IIS is revealed.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from _helpers import requires_gurobi

from iis_summarization.enumeration import EnumerationOptions, enumerate_iises

SKILL_ROOT = Path(__file__).parent.parent
FIXTURES = SKILL_ROOT / "tests" / "fixtures"


def _write_overlapping_lp(path: Path) -> None:
    path.write_text(
        "Minimize\n"
        " obj: x\n"
        "Subject To\n"
        " need_high: x >= 10\n"
        " cap_a: x <= 5\n"
        " cap_b: x <= 6\n"
        "Bounds\n"
        " 0 <= x <= 100\n"
        "End\n"
    )


@requires_gurobi
class TestRemoveMode:
    def test_tiny_finds_one_iis_then_feasible(self, tmp_path: Path) -> None:
        result = enumerate_iises(
            FIXTURES / "tiny_infeasible.lp",
            output_dir=tmp_path,
            options=EnumerationOptions(max_iises=5),
        )
        assert result.success is True
        assert result.iis_count == 1
        assert result.terminated_reason == "feasible"

    def test_overlapping_iises_hidden_by_removal(self, tmp_path: Path) -> None:
        lp = tmp_path / "overlap.lp"
        _write_overlapping_lp(lp)
        result = enumerate_iises(
            lp, output_dir=tmp_path, options=EnumerationOptions(max_iises=5)
        )
        assert result.success is True
        # Removing the first IIS deletes the shared constraint, so the
        # overlapping second IIS is never seen.
        assert result.iis_count == 1


@requires_gurobi
class TestLocalizedSummary:
    def test_japanese_enumeration_summary(self, tmp_path: Path) -> None:
        from iis_summarization.enumeration import write_enumeration_summary

        result = enumerate_iises(
            FIXTURES / "tiny_infeasible.lp",
            output_dir=tmp_path,
            options=EnumerationOptions(max_iises=3),
        )
        path = write_enumeration_summary(
            result,
            lp_file=FIXTURES / "tiny_infeasible.lp",
            output_dir=tmp_path,
            language="ja",
        )
        text = path.read_text()
        assert "IIS 列挙レポート" in text
        assert "実行可能に到達" in text  # terminated_reason localized


@requires_gurobi
class TestRelaxMode:
    def test_relax_mode_reveals_overlapping_iises(self, tmp_path: Path) -> None:
        """Gurobi guidance: relax (loosen RHS) instead of removing, so
        IISes that share constraints with already-found ones surface."""
        lp = tmp_path / "overlap.lp"
        _write_overlapping_lp(lp)
        result = enumerate_iises(
            lp,
            output_dir=tmp_path,
            options=EnumerationOptions(max_iises=6, relax_instead_of_remove=True),
        )
        assert result.success is True
        assert result.iis_count >= 2
        found_sets = {frozenset(f.constraint_names) for f in result.iises}
        assert frozenset({"need_high", "cap_a"}) in found_sets
        assert frozenset({"need_high", "cap_b"}) in found_sets

    def test_relax_mode_terminates_on_stubborn_conflict(self, tmp_path: Path) -> None:
        """Epsilon-relaxation cannot fix a wide conflict (gap of 5 on the
        tiny model) immediately — the loop must escalate and terminate,
        never spin forever re-finding the same IIS."""
        result = enumerate_iises(
            FIXTURES / "tiny_infeasible.lp",
            output_dir=tmp_path,
            options=EnumerationOptions(max_iises=6, relax_instead_of_remove=True),
        )
        assert result.success is True
        # Exactly one DISTINCT IIS exists; duplicates must not be recorded.
        assert result.iis_count == 1
        assert result.terminated_reason in ("feasible", "max_iises")
