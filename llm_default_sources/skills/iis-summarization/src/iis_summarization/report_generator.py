"""
report_generator.py
───────────────────
Step 8 of the IIS analysis pipeline.

Renders the Markdown infeasibility report by filling a small template.
The file produced is intentionally minimal: document header, a one-line
placeholder for the summarizer agent's narrative, and an appendix of
culprit-constraint bodies. The orchestrator (``SKILL.md``) replaces the
placeholder with agent-produced Verdict / Why / Fix sections.

When the agent is not invoked (e.g. direct CLI use), the placeholder
stays in place and tells the reader how to complete the report.
"""

from __future__ import annotations

import logging
import time
from importlib import resources
from pathlib import Path
from string import Template

from iis_summarization.i18n import DEFAULT_LANGUAGE, tr
from iis_summarization.interfaces import IReportGenerator
from iis_summarization.models import (
    BatchRefinementResult,
    ClassificationResult,
    IISRunResult,
    ParsedILP,
    PropagationTrace,
    RelaxationResult,
    RemovalResult,
    SemanticGroupResult,
)

logger = logging.getLogger(__name__)


_TEMPLATE_FILENAME = "infeasibility_report.md"

# Text written into ``$narrative`` when the skill's summarizer agent has
# not been invoked. The orchestrator in ``SKILL.md`` uses the ``Edit``
# tool to replace this exact string with the agent's Markdown output,
# so the string must be unique and stable across runs.
_NARRATIVE_PLACEHOLDER = (
    "> Root Cause / Background / Alternatives are produced by the summarizer subagent. "
    "Run `/iis-summarization <path>` via Claude Code to populate "
    "this section. When run from the bare CLI the report contains only "
    "this placeholder and the technical details below."
)


def _default_template_text() -> str:
    """Return the bundled template text, compatible with both source and
    installed layouts (``importlib.resources``)."""
    return (
        resources.files("iis_summarization")
        .joinpath("templates")
        .joinpath(_TEMPLATE_FILENAME)
        .read_text(encoding="utf-8")
    )


class ReportGenerator(IReportGenerator):
    """Default implementation of :class:`IReportGenerator`."""

    def __init__(self, template_path: Path | None = None) -> None:
        self._template_path = template_path

    @classmethod
    def create(cls, template_path: Path | None = None) -> IReportGenerator:
        """Factory returning an :class:`IReportGenerator`."""
        return cls(template_path=template_path)

    def generate(
        self,
        lp_file: Path,
        parsed_ilp: ParsedILP,
        removal_result: RemovalResult,
        relaxation_result: RelaxationResult | None,
        classification_result: ClassificationResult | None,
        grouping_result: SemanticGroupResult | None,
        output_dir: Path,
        refinement_result: BatchRefinementResult | None = None,
        iis_result: IISRunResult | None = None,
        language: str = DEFAULT_LANGUAGE,
        propagation_result: PropagationTrace | None = None,
    ) -> Path:
        return _generate_report_impl(
            template_path=self._template_path,
            lp_file=lp_file,
            parsed_ilp=parsed_ilp,
            removal_result=removal_result,
            relaxation_result=relaxation_result,
            classification_result=classification_result,
            grouping_result=grouping_result,
            refinement_result=refinement_result,
            output_dir=output_dir,
            iis_result=iis_result,
            language=language,
            propagation_result=propagation_result,
        )


def generate_report(
    lp_file: str | Path,
    parsed_ilp: ParsedILP,
    removal_result: RemovalResult,
    relaxation_result: RelaxationResult | None = None,
    classification_result: ClassificationResult | None = None,
    grouping_result: SemanticGroupResult | None = None,
    output_dir: str | Path | None = None,
    refinement_result: BatchRefinementResult | None = None,
    iis_result: IISRunResult | None = None,
    language: str = DEFAULT_LANGUAGE,
) -> Path:
    """Functional convenience wrapper around :class:`ReportGenerator`.

    ``classification_result``, ``grouping_result``, and
    ``refinement_result`` populate the ``## Diagnostic findings``
    section when they carry useful signal. ``language`` (``"en"`` /
    ``"ja"``) localizes every Python-written header and label;
    constraint/variable names and numbers stay verbatim.
    """
    lp_path = Path(lp_file)
    out_dir = Path(output_dir) if output_dir is not None else lp_path.parent
    return ReportGenerator.create().generate(
        lp_file=lp_path,
        parsed_ilp=parsed_ilp,
        removal_result=removal_result,
        relaxation_result=relaxation_result,
        classification_result=classification_result,
        grouping_result=grouping_result,
        output_dir=out_dir,
        refinement_result=refinement_result,
        iis_result=iis_result,
        language=language,
    )


# ─────────────────────────────────────────────────────────────
# Rendering helpers
# ─────────────────────────────────────────────────────────────


# Hard cap on the number of lines the appendix block is allowed to
# emit. Each constraint contributes a short Markdown block (header +
# fenced `lp` body). Long constraint bodies are truncated inline; if
# the running total would exceed this cap we stop adding constraints
# and emit a one-line summary of how many were omitted. Keeps the
# report readable even when the reduced IIS still has hundreds of
# constraint-name templates.
_APPENDIX_LINE_LIMIT = 200

# Show at most this many forcing-chain steps; an IIS whose propagation
# produces many tightenings cannot flood the report. The contradiction
# line is always shown regardless.
_TRACE_STEP_LIMIT = 40


def _value_trace_block(
    propagation: PropagationTrace | None,
    language: str = DEFAULT_LANGUAGE,
) -> str:
    """Render the Step 5.5 forcing chain as a top-level section.

    When propagation reached a numeric contradiction this is the most
    valuable part of the report — the ordered "what forces what" with
    real values, ending at the exact empty domain. When it did not, a
    single honest line says the conflict is combinatorial and points to
    the constraint list below. The per-step explanations and the
    contradiction detail are already localized by :mod:`propagation`;
    this wrapper localizes only its own header and labels.
    """
    if propagation is None or not propagation.success:
        return ""

    header = "## " + tr(language, "value_trace_header")

    if not propagation.reached_contradiction:
        if not propagation.steps:
            return ""
        return header + "\n\n" + tr(language, "value_trace_combinatorial")

    lines = [
        header,
        "",
        tr(language, "value_trace_intro"),
        "",
    ]
    steps = propagation.steps
    omitted = 0
    if len(steps) > _TRACE_STEP_LIMIT:
        omitted = len(steps) - _TRACE_STEP_LIMIT
        steps = steps[-_TRACE_STEP_LIMIT:]
    if omitted:
        lines.append(tr(language, "value_trace_omitted", n=omitted))
    for i, step in enumerate(steps, start=1):
        lines.append(f"{i}. {step.explanation}")
    lines.append("")
    c = propagation.contradiction
    if c is not None:
        lines.append(f"**{tr(language, 'contradiction_label')}:** {c.detail}")
    return "\n".join(lines)


def _refinement_block(refinement: BatchRefinementResult | None) -> str:
    """Render the Step 3.5 outcome as a short Markdown paragraph.

    Surfaces three signals:
    - **Root cause** — a single constraint whose re-addition flipped
      the LP back to infeasible (sharpest pinpoint).
    - **Joint culprits** — every add-back probe kept the LP feasible,
      so the conflict requires multiple constraints together.
    - **Multiple IISes** — removing the entire IIS did not restore
      feasibility, so this is not the only IIS in the model. Important
      because fixing the listed constraints alone will *not* make the
      model feasible.
    """
    if refinement is None:
        return ""
    if refinement.has_root_cause:
        return (
            "**Root cause (Step 3.5):** `"
            f"{refinement.root_cause}`. Re-adding this single constraint to "
            "the LP-minus-IIS model is what flips it back to infeasible — "
            "fix this one first."
        )
    if refinement.success and refinement.joint_culprits:
        return (
            f"**Joint culprits (Step 3.5):** {len(refinement.joint_culprits)} "
            "constraint(s) together cause the conflict; no single one alone "
            "is sufficient. Listed in the appendix below."
        )
    msg = (refinement.error_message or "").lower()
    if "multiple iises" in msg or "did not restore feasibility" in msg:
        return (
            "**Multiple IISes detected:** removing the IIS below did not "
            "restore feasibility, so this is **not the only** infeasible "
            "subsystem in the model. Fixing only the listed constraints "
            "will leave the model infeasible.\n\n"
            "**Suggested next steps:**\n"
            "1. Fix the conflict described below in the input data or model logic.\n"
            "2. Re-run the skill — the auto-update cache will regenerate the "
            "`.ilp`, exposing the *next* IIS.\n"
            "3. Repeat until removing the discovered IIS leaves the model "
            "feasible (this section will then change to a single-root-cause "
            "or joint-culprits verdict).\n"
            "4. If iteration is slow, look for a common upstream cause — "
            "multiple IISes often trace back to one bad data row "
            "(time slot, asset, parameter) that fans out into many local conflicts."
        )
    return ""


_CLASSIFICATION_TABLE_LIMIT = 10  # max rows shown in the main report


def _classification_block(classification: ClassificationResult | None) -> str:
    """Render the Step 5 DATA/STRUCTURE table.

    DATA = constraint infeasible in isolation given variable bounds.
    STRUCTURE = constraint reachable alone; conflict arises only in
    combination with other IIS constraints.

    Only the first _CLASSIFICATION_TABLE_LIMIT rows are shown (DATA
    constraints first). When all constraints share one type the Type
    column is dropped (redundant). Zero counts are omitted from the
    summary line.
    """
    if classification is None or not classification.success or not classification.classifications:
        return ""
    counts = classification.counts

    # Build compact summary: skip zero counts.
    summary_parts = []
    if counts["data"] > 0:
        summary_parts.append(f"{counts['data']} DATA")
    if counts["structure"] > 0:
        summary_parts.append(f"{counts['structure']} STRUCTURE")
    if counts["unknown"] > 0:
        summary_parts.append(f"{counts['unknown']} unknown")
    summary = ", ".join(summary_parts)

    # Drop Type column when all constraints are the same type (avoids
    # a column that says the same word on every row).
    unique_types = {c.problem_type.lower() for c in classification.classifications}
    show_type_col = len(unique_types) > 1

    if show_type_col:
        header = f"**Diagnosis:** {summary}.\n\n| Constraint | Type | Reason |\n|---|---|---|\n"
    else:
        header = f"**Diagnosis:** {summary}.\n\n| Constraint | Reason |\n|---|---|\n"

    # Sort: DATA first (most actionable), then STRUCTURE, then unknown.
    _order = {"data": 0, "structure": 1, "unknown": 2}
    sorted_cs = sorted(
        classification.classifications,
        key=lambda c: _order.get(c.problem_type.lower(), 9),
    )
    rows: list[str] = []
    for c in sorted_cs[:_CLASSIFICATION_TABLE_LIMIT]:
        reason = (c.reason or "").replace("\n", " ").strip()
        if len(reason) > 100:
            reason = reason[:100].rstrip() + " …"
        if show_type_col:
            rows.append(f"| `{c.constraint_name}` | **{c.problem_type.upper()}** | {reason} |")
        else:
            rows.append(f"| `{c.constraint_name}` | {reason} |")
    body = header + "\n".join(rows)
    remaining = len(sorted_cs) - _CLASSIFICATION_TABLE_LIMIT
    if remaining > 0:
        body += f"\n\n_… {remaining} more. See constraint details below._"
    return body


def _grouping_block(grouping: SemanticGroupResult | None) -> str:
    """Render the Step 6 conflict subsystems.

    A single subsystem is the normal case and adds no information —
    only emit output when there are multiple independent subsystems,
    since that signals they can be debugged separately.
    """
    if grouping is None or not grouping.success or not grouping.groups:
        return ""
    if grouping.group_count <= 1:
        return ""  # single subsystem is obvious — no need to state it
    lines = [
        f"**{grouping.group_count} independent conflict subsystems** — "
        "each can be debugged separately.\n"
    ]
    for g in grouping.groups:
        lines.append(
            f"- Group {g.group_id}: {len(g.constraints)} constraint(s), "
            f"{len(g.variables)} variable(s)."
        )
    return "\n".join(lines)


def _numerics_block(
    iis_result: IISRunResult | None, language: str = DEFAULT_LANGUAGE
) -> str:
    """Render the proactive numerics screen (Gurobi scaling guidelines).

    The warning sentences themselves come from the engine in English —
    they carry numeric evidence and Gurobi terminology that must not
    drift in translation; only the section header is localized.
    """
    if iis_result is None or not iis_result.numerics_warnings:
        return ""
    lines = ["### " + tr(language, "numerics_header") + "\n"]
    for w in iis_result.numerics_warnings:
        lines.append(f"- {w}")
    return "\n".join(lines)


def _nonlinear_block(
    iis_result: IISRunResult | None, language: str = DEFAULT_LANGUAGE
) -> str:
    """Render quadratic/SOS/general IIS members with per-type remedies.

    feasRelax can relax only linear constraints and variable bounds
    (documented Gurobi limitation); the remedy differs by type:
    indicators get slack injection (Step 7b), convex quadratics admit
    the same pattern, SOS sets have no numeric relaxation at all.
    """
    if iis_result is None or not iis_result.has_nonlinear_constraints:
        return ""
    lines = ["### " + tr(language, "nonlinear_header") + "\n"]
    if iis_result.nonlinear_iis_members:
        for m in iis_result.nonlinear_iis_members:
            kind = m.split(":", 1)[0]
            remedy_key = f"remedy_{kind}"
            try:
                hint = tr(language, remedy_key)
            except KeyError:
                hint = tr(language, "remedy_fallback")
            lines.append(f"- `{m}` — {hint}.")
        lines.append("")
    lines.append(tr(language, "nonlinear_note"))
    return "\n".join(lines)


def _remediation_block(
    relaxation: RelaxationResult | None, language: str = DEFAULT_LANGUAGE
) -> str:
    """Render Step 7's numeric remediation plan: per-constraint RHS
    changes, per-bound changes, and the fix-verification verdict.

    This is the concrete "how to solve" answer — only rendered when
    feasRelax actually produced violation amounts. Indicator-constraint
    remediation (slack injection) is rendered even when the linear pass
    was skipped or failed, since it is computed independently.
    """
    if relaxation is None:
        return ""

    parts: list[str] = []
    linear = _linear_remediation_block(relaxation, language)
    if linear:
        parts.append(linear)
    indicator = _indicator_remediation_block(relaxation, language)
    if indicator:
        parts.append(indicator)
    return "\n\n".join(parts)


def _indicator_remediation_block(
    relaxation: RelaxationResult, language: str = DEFAULT_LANGUAGE
) -> str:
    """Render slack-injection results for indicator constraints in the IIS."""
    if not relaxation.indicator_relaxations:
        return ""
    lines = [
        "### " + tr(language, "indicator_header") + "\n",
        tr(language, "indicator_intro") + "\n",
        tr(language, "indicator_table_header"),
        "|---|---|---|---|---|",
    ]
    for r in relaxation.indicator_relaxations:
        lines.append(
            f"| `{r.constraint_name}` | {r.sense} | {r.current_rhs:.6g} "
            f"| **{r.suggested_new_rhs:.6g}** | {r.direction} |"
        )
    if relaxation.indicator_fix_verified is True:
        lines.append("")
        lines.append(tr(language, "fix_verified_line"))
    elif relaxation.indicator_fix_verified is False:
        lines.append("")
        lines.append(
            tr(language, "fix_not_verified_line", msg=relaxation.indicator_fix_message)
        )
    return "\n".join(lines)


def _linear_remediation_block(
    relaxation: RelaxationResult, language: str = DEFAULT_LANGUAGE
) -> str:
    """Render Step 7's linear feasRelax remediation table."""
    if not relaxation.success:
        return ""
    if not relaxation.constraint_relaxations and not relaxation.variable_bound_relaxations:
        return ""

    lines = ["### " + tr(language, "remediation_header") + "\n"]
    if relaxation.constraint_relaxations:
        lines.append(tr(language, "remediation_table_header"))
        lines.append("|---|---|---|---|---|")
        for r in relaxation.constraint_relaxations:
            lines.append(
                f"| `{r.constraint_name}` | {r.sense} | {r.current_rhs:.6g} "
                f"| **{r.suggested_new_rhs:.6g}** | {r.direction} |"
            )
    if relaxation.variable_bound_relaxations:
        lines.append("")
        lines.append(tr(language, "bound_relax_table_header"))
        lines.append("|---|---|---|")
        for b in relaxation.variable_bound_relaxations:
            moves = []
            if b.lb_violation > 0:
                moves.append(tr(language, "lb_down_by", v=f"{b.lb_violation:.6g}"))
            if b.ub_violation > 0:
                moves.append(tr(language, "ub_up_by", v=f"{b.ub_violation:.6g}"))
            if b.range_of:
                moves.append(tr(language, "widens_range_note", name=b.range_of))
            lines.append(
                f"| `{b.variable_name}` | [{b.current_lb:.6g}, {b.current_ub:.6g}] "
                f"| {'; '.join(moves)} |"
            )
    lines.append("")
    lines.append(
        tr(language, "total_violation_line", v=f"{relaxation.total_violation:.6g}")
    )
    if relaxation.fix_verified is True:
        lines.append(tr(language, "fix_verified_line"))
    elif relaxation.fix_verified is False:
        lines.append(
            tr(language, "fix_not_verified_line", msg=relaxation.fix_verification_message)
        )
    return "\n".join(lines)


def _diagnostics_block(
    refinement: BatchRefinementResult | None,
    classification: ClassificationResult | None,
    grouping: SemanticGroupResult | None,
    relaxation: RelaxationResult | None = None,
    language: str = DEFAULT_LANGUAGE,
) -> str:
    """Combine the deterministic-pipeline signals into one section.

    Returns an empty string when every sub-block is empty, so the
    surrounding ``---`` separators in the template don't leave a bare
    section header on the page.
    """
    parts = [
        _refinement_block(refinement),
        _classification_block(classification),
        _grouping_block(grouping),
        _remediation_block(relaxation, language),
    ]
    body = "\n\n".join(p for p in parts if p)
    if not body:
        return ""
    return "## " + tr(language, "diagnostics_header") + "\n\n" + body + "\n\n---\n"


def _constraint_blocks(names: list[str], parsed_ilp: ParsedILP) -> str:
    if not names:
        return "_No culprit constraints recorded._"

    parts: list[str] = []
    total_lines = 0
    rendered = 0

    for name in names:
        body = parsed_ilp.constraints.get(name, "(body not available)")
        # Truncate excessively long one-liners (e.g. sum-over-48-terms
        # rollups) at 400 characters so a single constraint cannot
        # dominate the appendix.
        if len(body) > 400:
            body = body[:400].rstrip() + " …"
        block = f"#### `{name}`\n\n```lp\n{body}\n```\n"
        block_lines = block.count("\n") + 1
        if total_lines + block_lines > _APPENDIX_LINE_LIMIT and parts:
            break
        parts.append(block)
        total_lines += block_lines + 1  # +1 for the join separator
        rendered += 1

    remaining = len(names) - rendered
    if remaining > 0:
        parts.append(
            f"_… and {remaining} more constraint(s) omitted to keep the "
            "appendix under "
            f"{_APPENDIX_LINE_LIMIT} lines. See the reduced `.ilp` file "
            "for the full list._"
        )
    return "\n".join(parts)


def _culprit_names(
    removal_result: RemovalResult,
    relaxation_result: RelaxationResult | None,
    parsed_ilp: ParsedILP,
) -> list[str]:
    """Pick the most specific constraint set available for the appendix."""
    if removal_result.culprit_constraints:
        return list(removal_result.culprit_constraints)
    if relaxation_result and relaxation_result.constraint_relaxations:
        return [r.constraint_name for r in relaxation_result.constraint_relaxations]
    return list(parsed_ilp.constraints.keys())


def _default_lb_warning(
    iis_result: IISRunResult | None, language: str = DEFAULT_LANGUAGE
) -> str:
    """Emit a warning when variables with Gurobi's default LB=0 appear in the IIS."""
    if not iis_result or not iis_result.has_default_lb_issues:
        return ""
    vars_list = ", ".join(f"`{v}`" for v in iis_result.has_default_lb_issues[:10])
    more = f" (and {len(iis_result.has_default_lb_issues) - 10} more)" if len(iis_result.has_default_lb_issues) > 10 else ""
    if language == "ja":
        return (
            tr(language, "default_lb_header") + "\n\n"
            "Gurobi はすべての変数に自動的に下限 0 を設定します。次の変数は "
            f"IIS に下限 0 で含まれており、負の値を許容すべき変数であれば意図"
            f"しない設定の可能性があります: {vars_list}{more}\n\n"
            "自由変数（下に非有界）にすべき変数があれば "
            "`var.LB = -GRB.INFINITY` を設定してください。\n"
        )
    return (
        "**Warning: Default Lower Bound = 0**\n\n"
        "Gurobi automatically sets a lower bound of 0 on all variables. The following "
        "variables have LB=0 in the IIS, which may be unintentional if these variables "
        f"should allow negative values: {vars_list}{more}\n\n"
        "If any of these variables should be free (unbounded below), set "
        "`var.LB = -GRB.INFINITY`.\n"
    )


def _iis_bounds_block(
    iis_result: IISRunResult | None, language: str = DEFAULT_LANGUAGE
) -> str:
    """Render IIS variable bounds as a Markdown table."""
    if not iis_result or not iis_result.iis_bounds:
        return ""
    lines = [
        tr(language, "iis_bounds_header") + "\n",
        tr(language, "iis_bounds_table_header"),
        "|----------|-----------|-------|",
    ]
    has_range_slack = False
    for b in iis_result.iis_bounds:
        btype = tr(
            language,
            "lower_bound_label" if b.bound_type == "lb" else "upper_bound_label",
        )
        if b.range_of:
            has_range_slack = True
            label = tr(language, "range_slack_label", var=b.varname, name=b.range_of)
        else:
            label = f"`{b.varname}`"
        lines.append(f"| {label} | {btype} | {b.bound_value} |")
    if has_range_slack:
        lines.append("")
        lines.append(tr(language, "range_slack_note"))
    return "\n".join(lines)


def _generate_report_impl(
    template_path: Path | None,
    lp_file: Path,
    parsed_ilp: ParsedILP,
    removal_result: RemovalResult,
    relaxation_result: RelaxationResult | None,
    classification_result: ClassificationResult | None,
    grouping_result: SemanticGroupResult | None,
    refinement_result: BatchRefinementResult | None,
    output_dir: Path,
    iis_result: IISRunResult | None = None,
    language: str = DEFAULT_LANGUAGE,
    propagation_result: PropagationTrace | None = None,
) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)

    culprit_names = _culprit_names(removal_result, relaxation_result, parsed_ilp)

    diag_parts = [
        _diagnostics_block(
            refinement_result,
            classification_result,
            grouping_result,
            relaxation_result,
            language,
        ),
        _numerics_block(iis_result, language),
        _nonlinear_block(iis_result, language),
        _default_lb_warning(iis_result, language),
        _iis_bounds_block(iis_result, language),
    ]
    diagnostics = "\n\n".join(p for p in diag_parts if p)

    values = {
        "model_file": str(lp_file),
        "analysis_date": time.strftime("%Y-%m-%d %H:%M:%S"),
        "narrative": _NARRATIVE_PLACEHOLDER,
        "diagnostics": diagnostics,
        "culprit_constraints_blocks": _constraint_blocks(culprit_names, parsed_ilp),
        "report_title": tr(language, "report_title"),
        "generated_label": tr(language, "generated_label"),
        "tech_details_summary": tr(language, "tech_details_summary"),
        "report_footer": tr(language, "report_footer"),
        "value_trace": _value_trace_block(propagation_result, language),
    }

    if template_path is None:
        template_text = _default_template_text()
    else:
        if not template_path.exists():
            raise FileNotFoundError(f"Report template not found at: {template_path}")
        template_text = template_path.read_text(encoding="utf-8")
    rendered = Template(template_text).safe_substitute(values)

    report_path = output_dir / f"{lp_file.stem}_infeasibility_report.md"
    report_path.write_text(rendered, encoding="utf-8")
    logger.info("Report written to %s", report_path)

    _write_agent_context(
        lp_file=lp_file,
        output_dir=output_dir,
        report_path=report_path,
        classification_result=classification_result,
        refinement_result=refinement_result,
        iis_result=iis_result,
        language=language,
    )

    return report_path


def _write_agent_context(
    lp_file: Path,
    output_dir: Path,
    report_path: Path,
    classification_result: ClassificationResult | None,
    refinement_result: BatchRefinementResult | None,
    iis_result: IISRunResult | None,
    language: str,
) -> Path:
    """Write ``<stem>_agent_context.txt`` — everything the skill orchestrator
    previously had to Read out of the report and paste into the summarizer
    prompt (classifier table, default-LB warnings, root-cause hint, report
    language). With this sidecar the orchestrator passes file paths to the
    subagent and never loads the report into its own context."""
    stem = lp_file.stem
    reduced = output_dir / f"{stem}_iis_reduced.ilp"
    raw = output_dir / f"{stem}_iis.ilp"
    classifier = _classification_block(classification_result) or "not available"
    default_lb = _default_lb_warning(iis_result, language) or "none"
    root_cause = _refinement_block(refinement_result) or "not isolated"
    content = (
        f"language: {language}\n"
        f"report: {report_path}\n"
        f"reduced_ilp: {reduced if reduced.exists() else 'none'}\n"
        f"raw_ilp: {raw if raw.exists() else 'none'}\n"
        "\n"
        "## Classifier labels (DATA = infeasible in isolation, STRUCTURE = "
        "conflicts only in combination)\n\n"
        f"{classifier}\n\n"
        "## Default-LB=0 warnings\n\n"
        f"{default_lb}\n\n"
        "## Root cause hint\n\n"
        f"{root_cause}\n"
    )
    context_path = output_dir / f"{stem}_agent_context.txt"
    context_path.write_text(content, encoding="utf-8")
    logger.info("Agent context written to %s", context_path)
    return context_path
