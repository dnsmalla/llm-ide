"""
test_report_i18n.py
───────────────────
Localization tests for the Python-written report. The language is
resolved once (explicit --lang ▸ OS locale ▸ English) and threaded to
the report generator; every Python-written section header and label
must follow it. Constraint/variable names and numbers stay verbatim.
"""

from __future__ import annotations

from collections import Counter
from pathlib import Path

import pytest

from iis_summarization.models import (
    ConstraintRelaxation,
    IISRunResult,
    ParsedILP,
    RelaxationResult,
    RemovalResult,
)
from iis_summarization.report_generator import generate_report

SKILL_ROOT = Path(__file__).parent.parent
FIXTURES = SKILL_ROOT / "tests" / "fixtures"


@pytest.fixture()
def tiny_parsed() -> ParsedILP:
    p = ParsedILP()
    p.constraints = {
        "demand_min": "x + y >= 10",
        "capacity_max": "x + y <= 5",
    }
    p.variable_refs = Counter({"demand_min": 2, "capacity_max": 2})
    p.bounds = {"x": "0 <= x <= 100"}
    return p


@pytest.fixture()
def removal() -> RemovalResult:
    return RemovalResult(success=False, iterations_performed=0, message="Skipped.")


def _full_relaxation() -> RelaxationResult:
    return RelaxationResult(
        success=True,
        constraint_relaxations=[
            ConstraintRelaxation(
                constraint_name="capacity_max",
                current_rhs=5.0,
                sense="<=",
                violation=5.0,
                direction="increase RHS (or reduce LHS contribution)",
            ),
        ],
        total_violation=5.0,
        fix_verified=True,
        fix_verification_message="verified.",
        indicator_relaxations=[
            ConstraintRelaxation(
                constraint_name="ind",
                current_rhs=10.0,
                sense=">=",
                violation=5.0,
                direction="decrease RHS",
            ),
        ],
        indicator_fix_verified=True,
        indicator_fix_message="verified.",
    )


def _full_iis_result() -> IISRunResult:
    return IISRunResult(
        success=True,
        numerics_warnings=["LOW CONFIDENCE: matrix coefficients span 1.0e+15"],
        has_nonlinear_constraints=True,
        nonlinear_iis_members=["indicator: ind"],
    )


class TestJapaneseReport:
    def test_japanese_headers_throughout(
        self, tmp_path: Path, tiny_parsed: ParsedILP, removal: RemovalResult
    ) -> None:
        path = generate_report(
            lp_file=FIXTURES / "tiny_infeasible.lp",
            parsed_ilp=tiny_parsed,
            removal_result=removal,
            relaxation_result=_full_relaxation(),
            output_dir=tmp_path,
            iis_result=_full_iis_result(),
            language="ja",
        )
        content = path.read_text()
        assert "# 実行不可能性レポート" in content
        assert "修正プラン" in content  # remediation plan
        assert "修正を検証済み" in content  # fix verified
        assert "数値的健全性" in content  # numerical health
        assert "インジケータ制約の修正" in content  # indicator remediation
        # Names and numbers stay verbatim regardless of language.
        assert "`capacity_max`" in content
        assert "**10**" in content

    def test_splice_placeholder_stays_english(
        self, tmp_path: Path, tiny_parsed: ParsedILP, removal: RemovalResult
    ) -> None:
        """The narrative placeholder is an orchestrator contract — the
        skill splices the subagent output by exact-matching this line,
        so it must be byte-identical in every language."""
        from iis_summarization.report_generator import _NARRATIVE_PLACEHOLDER

        path = generate_report(
            lp_file=FIXTURES / "tiny_infeasible.lp",
            parsed_ilp=tiny_parsed,
            removal_result=removal,
            output_dir=tmp_path,
            language="ja",
        )
        assert _NARRATIVE_PLACEHOLDER in path.read_text()


class TestEnglishDefault:
    def test_english_without_language_arg(
        self, tmp_path: Path, tiny_parsed: ParsedILP, removal: RemovalResult
    ) -> None:
        path = generate_report(
            lp_file=FIXTURES / "tiny_infeasible.lp",
            parsed_ilp=tiny_parsed,
            removal_result=removal,
            relaxation_result=_full_relaxation(),
            output_dir=tmp_path,
        )
        content = path.read_text()
        assert "# Infeasibility Report" in content
        assert "Remediation plan" in content


def test_cli_accepts_lang_flag() -> None:
    from iis_summarization.cli import _build_parser

    parser = _build_parser()
    args = parser.parse_args([str(FIXTURES / "tiny_infeasible.lp"), "--lang", "ja"])
    assert args.lang == "ja"
