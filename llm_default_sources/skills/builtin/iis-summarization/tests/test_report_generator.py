"""
test_report_generator.py
────────────────────────
Tests for iis_summarization.report_generator. The report generator
now writes a minimal template (header + narrative placeholder +
appendix) — the narrative prose is produced by the summarizer
subagent, not by Python. These tests verify the template shape,
placeholder substitution, and the splice marker used by the
orchestrator.
"""

from __future__ import annotations

import re
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
from iis_summarization.report_generator import (
    _NARRATIVE_PLACEHOLDER,
    ReportGenerator,
    generate_report,
)

SKILL_ROOT = Path(__file__).parent.parent
FIXTURES = SKILL_ROOT / "tests" / "fixtures"
TEMPLATE_PATH = SKILL_ROOT / "src" / "iis_summarization" / "templates" / "infeasibility_report.md"


# ─────────────────────────────────────────────────────────────
# Shared fixtures
# ─────────────────────────────────────────────────────────────


@pytest.fixture()
def tiny_parsed() -> ParsedILP:
    p = ParsedILP()
    p.constraints = {
        "demand_min": "x + y >= 10",
        "capacity_max": "x + y <= 5",
    }
    p.variable_refs = Counter({"demand_min": 2, "capacity_max": 2})
    p.bounds = {"x": "0 <= x <= 100", "y": "0 <= y <= 100"}
    return p


@pytest.fixture()
def success_result(tmp_path: Path) -> RemovalResult:
    return RemovalResult(
        success=True,
        iterations_performed=2,
        culprit_constraints=["capacity_max"],
        all_removed_constraints=["demand_min", "capacity_max"],
        feasible_model_file=tmp_path / "tiny_iter_02.lp",
        final_solve_time=0.42,
        message="Model became feasible at iteration 2.",
    )


@pytest.fixture()
def failure_result() -> RemovalResult:
    return RemovalResult(
        success=False,
        iterations_performed=0,
        message="Skipped by --skip-reduce.",
    )


# ─────────────────────────────────────────────────────────────
# Report shape — minimal template
# ─────────────────────────────────────────────────────────────


class TestReportShape:
    @pytest.fixture(autouse=True)
    def report(
        self,
        tmp_path: Path,
        tiny_parsed: ParsedILP,
        success_result: RemovalResult,
    ) -> None:
        self.path = generate_report(
            lp_file=FIXTURES / "tiny_infeasible.lp",
            parsed_ilp=tiny_parsed,
            removal_result=success_result,
            output_dir=tmp_path,
        )
        self.content = self.path.read_text()

    def test_report_file_created(self) -> None:
        assert self.path.exists()

    def test_filename_contains_model_stem(self) -> None:
        assert "tiny_infeasible" in self.path.name

    def test_model_path_present(self) -> None:
        assert "tiny_infeasible.lp" in self.content

    def test_title_is_infeasibility_report(self) -> None:
        assert "# Infeasibility Report —" in self.content

    def test_narrative_placeholder_present(self) -> None:
        # The orchestrator identifies this line verbatim via Edit to
        # splice in the agent's output. Any change here is a breaking
        # contract change and must be coordinated with SKILL.md.
        assert _NARRATIVE_PLACEHOLDER in self.content

    def test_technical_details_section_present(self) -> None:
        assert "Technical details" in self.content

    def test_culprit_constraint_in_appendix(self) -> None:
        assert "capacity_max" in self.content

    def test_no_deterministic_narrative_sections(self) -> None:
        # Explicit anti-regression: Python no longer writes Verdict /
        # Why / Fix headings. Only the agent does. The only `##`
        # section heading Python writes is the Appendix.
        for heading in ["## Verdict", "## Why", "## Fix"]:
            assert heading not in self.content, (
                f"Python should not write {heading!r} — that section is "
                "the summarizer subagent's job."
            )

    def test_no_emojis(self) -> None:
        emoji = re.compile("[\U0001f300-\U0001faff\U00002600-\U000026ff✀-➿]")
        assert emoji.search(self.content) is None


# ─────────────────────────────────────────────────────────────
# Appendix fallback (no numeric output from feasRelax)
# ─────────────────────────────────────────────────────────────


class TestAppendixFallback:
    def test_uses_full_iis_when_removal_and_relaxation_empty(
        self,
        tmp_path: Path,
        tiny_parsed: ParsedILP,
        failure_result: RemovalResult,
    ) -> None:
        # With no culprit_constraints from removal and no relaxation
        # output, the appendix falls back to the full parsed IIS so
        # the reader has something concrete.
        path = generate_report(
            lp_file=FIXTURES / "tiny_infeasible.lp",
            parsed_ilp=tiny_parsed,
            removal_result=failure_result,
            output_dir=tmp_path,
        )
        content = path.read_text()
        assert "demand_min" in content
        assert "capacity_max" in content

    def test_uses_relaxation_constraints_when_removal_empty(
        self,
        tmp_path: Path,
        tiny_parsed: ParsedILP,
        failure_result: RemovalResult,
    ) -> None:
        relaxation = RelaxationResult(
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
        )
        path = generate_report(
            lp_file=FIXTURES / "tiny_infeasible.lp",
            parsed_ilp=tiny_parsed,
            removal_result=failure_result,
            relaxation_result=relaxation,
            output_dir=tmp_path,
        )
        content = path.read_text()
        assert "capacity_max" in content


class TestRemediationBlock:
    def test_remediation_table_with_verified_fix(
        self,
        tmp_path: Path,
        tiny_parsed: ParsedILP,
        failure_result: RemovalResult,
    ) -> None:
        """When Step 7 produced relaxation amounts and the fix was
        verified, the report must show the suggested new RHS and the
        verification statement — that IS the 'how to solve' answer."""
        relaxation = RelaxationResult(
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
            fix_verification_message=(
                "Applying the suggested changes to a copy of the model "
                "restored feasibility (verified by re-solving)."
            ),
        )
        path = generate_report(
            lp_file=FIXTURES / "tiny_infeasible.lp",
            parsed_ilp=tiny_parsed,
            removal_result=failure_result,
            relaxation_result=relaxation,
            output_dir=tmp_path,
        )
        content = path.read_text()
        # Suggested new RHS = 5 + 5 = 10 must appear in a remediation table.
        assert "Remediation" in content
        assert "10" in content
        assert "verified by re-solving" in content

    def test_unverified_fix_is_flagged(
        self,
        tmp_path: Path,
        tiny_parsed: ParsedILP,
        failure_result: RemovalResult,
    ) -> None:
        relaxation = RelaxationResult(
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
            fix_verified=False,
            fix_verification_message="Re-solve ended with status 3.",
        )
        path = generate_report(
            lp_file=FIXTURES / "tiny_infeasible.lp",
            parsed_ilp=tiny_parsed,
            removal_result=failure_result,
            relaxation_result=relaxation,
            output_dir=tmp_path,
        )
        content = path.read_text()
        assert "NOT verified" in content


# ─────────────────────────────────────────────────────────────
# Template integrity
# ─────────────────────────────────────────────────────────────


class TestProductionWarnings:
    def test_numerics_warnings_rendered(
        self,
        tmp_path: Path,
        tiny_parsed: ParsedILP,
        success_result: RemovalResult,
    ) -> None:
        iis_result = IISRunResult(
            success=True,
            numerics_warnings=[
                "Matrix coefficients span 1.0e+15 — beyond Gurobi's 1e9 guideline."
            ],
        )
        path = generate_report(
            lp_file=FIXTURES / "tiny_infeasible.lp",
            parsed_ilp=tiny_parsed,
            removal_result=success_result,
            output_dir=tmp_path,
            iis_result=iis_result,
        )
        content = path.read_text()
        assert "Numerical health" in content
        assert "1e9 guideline" in content

    def test_nonlinear_caveat_rendered(
        self,
        tmp_path: Path,
        tiny_parsed: ParsedILP,
        success_result: RemovalResult,
    ) -> None:
        iis_result = IISRunResult(
            success=True,
            has_nonlinear_constraints=True,
            nonlinear_iis_members=["indicator: ind"],
        )
        path = generate_report(
            lp_file=FIXTURES / "tiny_infeasible.lp",
            parsed_ilp=tiny_parsed,
            removal_result=success_result,
            output_dir=tmp_path,
            iis_result=iis_result,
        )
        content = path.read_text()
        assert "indicator: ind" in content
        # The feasRelax-coverage caveat must be stated.
        assert "linear constraints and variable bounds" in content


class TestIndicatorRemediationBlock:
    def test_indicator_alternative_rendered(
        self,
        tmp_path: Path,
        tiny_parsed: ParsedILP,
        failure_result: RemovalResult,
    ) -> None:
        relaxation = RelaxationResult(
            success=False,  # linear Step 7 may have been skipped entirely
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
            indicator_fix_message=(
                "Applying the suggested indicator RHS changes to a copy of "
                "the model restored feasibility (verified by re-solving)."
            ),
        )
        path = generate_report(
            lp_file=FIXTURES / "tiny_infeasible.lp",
            parsed_ilp=tiny_parsed,
            removal_result=failure_result,
            relaxation_result=relaxation,
            output_dir=tmp_path,
        )
        content = path.read_text()
        assert "Indicator-constraint remediation" in content
        assert "`ind`" in content
        assert "**5**" in content  # suggested new RHS 10 - 5
        assert "verified by re-solving" in content


class TestTemplateIntegrity:
    def test_template_file_exists(self) -> None:
        assert TEMPLATE_PATH.exists(), "Report template is missing!"

    def test_template_has_required_placeholders(self) -> None:
        content = TEMPLATE_PATH.read_text()
        for ph in ["$model_file", "$analysis_date", "$narrative", "$culprit_constraints_blocks"]:
            assert ph in content, f"Missing placeholder: {ph}"

    def test_no_unresolved_placeholders_in_output(
        self,
        tmp_path: Path,
        tiny_parsed: ParsedILP,
        success_result: RemovalResult,
    ) -> None:
        path = generate_report(
            lp_file=FIXTURES / "tiny_infeasible.lp",
            parsed_ilp=tiny_parsed,
            removal_result=success_result,
            output_dir=tmp_path,
        )
        content = path.read_text()
        raw_placeholders = re.findall(r"\$[a-z_][a-z_0-9]{2,}", content)
        assert raw_placeholders == [], f"Unresolved placeholders found: {raw_placeholders}"


class TestFactoryInterface:
    def test_factory_produces_generator(
        self,
        tmp_path: Path,
        tiny_parsed: ParsedILP,
        success_result: RemovalResult,
    ) -> None:
        gen = ReportGenerator.create()
        out = gen.generate(
            lp_file=FIXTURES / "tiny_infeasible.lp",
            parsed_ilp=tiny_parsed,
            removal_result=success_result,
            relaxation_result=None,
            classification_result=None,
            grouping_result=None,
            output_dir=tmp_path,
        )
        assert out.exists()
