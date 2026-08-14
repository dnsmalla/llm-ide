"""
test_seed_iis.py
────────────────
Tests for the daily warm-start path: seed today's diagnosis with
yesterday's IIS (Gurobi-recommended pattern for structurally identical
models whose data changes day to day).

The seed must be VERIFIED against today's data first — if today's
conflict lives elsewhere, the seed is discarded and the normal
computeIIS path runs (otherwise the diagnosis would be wrong).
"""

from __future__ import annotations

from pathlib import Path

from _helpers import requires_gurobi

from iis_summarization.iis_runner import run_seeded_iis

SKILL_ROOT = Path(__file__).parent.parent
FIXTURES = SKILL_ROOT / "tests" / "fixtures"


@requires_gurobi
class TestSeededIIS:
    def test_valid_seed_skips_computeiis(self, tmp_path: Path) -> None:
        """Yesterday's IIS {demand_min, capacity_max} still conflicts in
        today's model — the seeded path must produce a subset .ilp from
        TODAY's data without running computeIIS."""
        result = run_seeded_iis(
            FIXTURES / "tiny_infeasible.lp",
            seed_names=["demand_min", "capacity_max"],
            output_dir=tmp_path,
        )
        assert result is not None
        assert result.success is True
        assert result.used_seed is True
        assert result.ilp_file is not None and result.ilp_file.exists()
        body = result.ilp_file.read_text()
        assert "demand_min" in body
        assert "capacity_max" in body
        # The subset comes from TODAY's model, not yesterday's bodies.
        assert "non_negative_x" not in body

    def test_stale_seed_is_rejected(self, tmp_path: Path) -> None:
        """A seed that is feasible under today's data must be rejected
        (returns None) so the caller falls back to a fresh computeIIS —
        never diagnose today's model with yesterday's conflict."""
        result = run_seeded_iis(
            FIXTURES / "tiny_infeasible.lp",
            seed_names=["non_negative_x", "non_negative_y"],
            output_dir=tmp_path,
        )
        assert result is None

    def test_empty_seed_is_rejected(self, tmp_path: Path) -> None:
        result = run_seeded_iis(
            FIXTURES / "tiny_infeasible.lp",
            seed_names=[],
            output_dir=tmp_path,
        )
        assert result is None


def test_cli_accepts_seed_ilp_flag() -> None:
    from iis_summarization.cli import _build_parser

    parser = _build_parser()
    args = parser.parse_args(
        [
            str(FIXTURES / "tiny_infeasible.lp"),
            "--seed-ilp",
            str(FIXTURES / "tiny_infeasible_iis.ilp"),
        ]
    )
    assert args.seed_ilp == FIXTURES / "tiny_infeasible_iis.ilp"
