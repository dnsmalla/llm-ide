"""
test_cli.py
───────────
Smoke tests for iis_summarization.cli.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from _helpers import requires_gurobi

from iis_summarization.cli import main

SKILL_ROOT = Path(__file__).parent.parent
FIXTURES = SKILL_ROOT / "tests" / "fixtures"


def test_cli_help_exits_cleanly() -> None:
    with pytest.raises(SystemExit) as exc_info:
        main(["--help"])
    assert exc_info.value.code == 0


def test_cli_help_documents_agent_mode() -> None:
    import argparse

    from iis_summarization.cli import _build_parser

    parser = _build_parser()
    # Parse --agent-mode to confirm argparse accepts it.
    args = parser.parse_args([str(FIXTURES / "tiny_infeasible.lp"), "--agent-mode"])
    assert args.agent_mode is True
    assert isinstance(parser, argparse.ArgumentParser)


def test_cli_missing_file_returns_nonzero(tmp_path: Path) -> None:
    missing = tmp_path / "nope.lp"
    rc = main([str(missing), "--output-dir", str(tmp_path)])
    assert rc != 0


def test_cli_accepts_iis_tuning_flags() -> None:
    """Gurobi Strategy 2: --iis-method and --numeric-focus are exposed."""
    from iis_summarization.cli import _build_parser

    parser = _build_parser()
    args = parser.parse_args(
        [
            str(FIXTURES / "tiny_infeasible.lp"),
            "--iis-method",
            "1",
            "--numeric-focus",
            "2",
            "--threads",
            "4",
        ]
    )
    assert args.iis_method == 1
    assert args.numeric_focus == 2
    assert args.threads == 4


def test_cli_iis_tuning_flags_default_to_none() -> None:
    from iis_summarization.cli import _build_parser

    parser = _build_parser()
    args = parser.parse_args([str(FIXTURES / "tiny_infeasible.lp")])
    assert args.iis_method is None
    assert args.numeric_focus is None


@requires_gurobi
class TestDefaultOutputFolder:
    def test_everything_lands_in_iis_summary(self, tmp_path: Path) -> None:
        """Without --output-dir, every generated file (report, .ilp,
        iterations workdir) goes into a single `iis_summary` folder next
        to the model — and nothing is written beside the .lp itself."""
        import shutil

        lp = tmp_path / "tiny_infeasible.lp"
        shutil.copy(FIXTURES / "tiny_infeasible.lp", lp)

        rc = main([str(lp), "--agent-mode", "--iis-timeout", "30"])
        assert rc == 0

        out = tmp_path / "iis_summary"
        assert (out / "tiny_infeasible_infeasibility_report.md").exists()
        assert (out / "tiny_infeasible_iis.ilp").exists()
        # No sibling .ilp or other artifacts scattered next to the model.
        assert not (tmp_path / "tiny_infeasible.ilp").exists()
        stray = [
            p.name
            for p in tmp_path.iterdir()
            if p.name not in ("tiny_infeasible.lp", "iis_summary")
        ]
        assert stray == []

    def test_enumeration_uses_iis_summary_too(self, tmp_path: Path) -> None:
        import shutil

        lp = tmp_path / "tiny_infeasible.lp"
        shutil.copy(FIXTURES / "tiny_infeasible.lp", lp)

        rc = main([str(lp), "--enumerate-iises", "--max-iises", "3"])
        assert rc == 0
        out = tmp_path / "iis_summary"
        assert (out / "tiny_infeasible_iis_enumeration.md").exists()


@requires_gurobi
class TestCLIRun:
    def test_mps_input_supported(self, tmp_path: Path) -> None:
        """Any Gurobi-readable format works — lock in .mps support."""
        import gurobipy as gp

        mps = tmp_path / "tiny_infeasible.mps"
        m = gp.read(str(FIXTURES / "tiny_infeasible.lp"))
        m.write(str(mps))
        m.dispose()

        rc = main(
            [
                str(mps),
                "--output-dir",
                str(tmp_path),
                "--agent-mode",
                "--iis-timeout",
                "30",
            ]
        )
        assert rc == 0
        assert (tmp_path / "tiny_infeasible_infeasibility_report.md").exists()

    def test_cli_runs_end_to_end(self, tmp_path: Path) -> None:
        rc = main(
            [
                str(FIXTURES / "tiny_infeasible.lp"),
                "--output-dir",
                str(tmp_path),
                "--skip-minimize",
                "--skip-classify",
                "--skip-grouping",
                "--iis-timeout",
                "30",
                "--feasibility-timeout",
                "10",
                "--max-iter",
                "3",
            ]
        )
        assert rc == 0
        reports = list(tmp_path.glob("*_infeasibility_report.md"))
        assert len(reports) == 1
