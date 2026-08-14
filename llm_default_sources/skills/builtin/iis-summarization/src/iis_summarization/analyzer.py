"""
analyzer.py
───────────
Orchestrator for the IIS Infeasibility Analysis pipeline.

This module exposes two public entry points:

* :class:`Analyzer` — the class-based orchestrator. Instantiate with
  :meth:`Analyzer.create` and call :meth:`run` per model.
* :func:`run_analysis` — functional convenience wrapper for the
  common single-shot case.

Pipeline
────────
    1. IIS computation                (iis_runner.IISRunner)
    2. ILP parsing                    (ilp_parser.parse_ilp)
    3. Iterative removal              (constraint_remover.iterative_removal)
    3.5. Batch refinement             (batch_refiner.refine_batch)
    4. Deletion filter (Chinneck)     (deletion_filter.minimize_iis)
    5. DATA vs STRUCTURE              (classifier.classify_iis_constraints)
    6. Semantic grouping              (semantic_groups.group_by_shared_variables)
    7. Relaxation analysis            (relaxation.compute_relaxations)
    8. Report generation              (report_generator.generate_report)
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

from iis_summarization.batch_refiner import BatchRefiner
from iis_summarization.classifier import Classifier
from iis_summarization.constraint_remover import ConstraintRemover, create_modified_lp
from iis_summarization.deletion_filter import DeletionFilter
from iis_summarization.feasibility import test_feasibility
from iis_summarization.errors import AnalysisAbortedError
from iis_summarization.large_model_filter import LargeModelFilter
from iis_summarization.iis_runner import IISRunner
from iis_summarization.ilp_parser import ILPParser
from iis_summarization.interfaces import (
    IBatchRefiner,
    IClassifier,
    IConstraintRemover,
    IDeletionFilter,
    IIISRunner,
    IILPParser,
    ILargeModelFilter,
    IPropagator,
    IRelaxer,
    IReportGenerator,
    ISemanticGrouper,
)
from iis_summarization.models import (
    BatchRefinementResult,
    ClassificationResult,
    DeletionFilterResult,
    IISRunResult,
    ParsedILP,
    PropagationTrace,
    RelaxationResult,
    RemovalResult,
    SemanticGroupResult,
)
from iis_summarization.propagation import Propagator
from iis_summarization.relaxation import Relaxer
from iis_summarization.report_generator import ReportGenerator
from iis_summarization.semantic_groups import SemanticGrouper

logger = logging.getLogger(__name__)


# Step 3 staircase: start with this many iterations, then extend by the
# same amount until feasibility is reached or ITERATION_HARD_CAP is hit.
ITERATION_INITIAL = 10
ITERATION_STEP = 10
ITERATION_HARD_CAP = 100

# Step 3.5 agent-mode direct refinement: when Step 3 is skipped (e.g.
# --agent-mode) and the IIS is no larger than this many constraints,
# run add-back refinement directly on the IIS itself to isolate a
# single root cause. The cap exists because add-back cost is O(|IIS|)
# feasibility solves on the full LP.
AGENT_MODE_REFINE_IIS_THRESHOLD = 20


@dataclass(frozen=True)
class AnalysisOptions:
    """User-tunable pipeline parameters.

    ``max_iterations=0`` (the default) enables the staircase extender: Step 3
    runs for :data:`ITERATION_INITIAL` iterations first; if the model is not
    yet feasible, another :data:`ITERATION_STEP` iterations are appended,
    reusing the constraints removed so far. The process stops at
    :data:`ITERATION_HARD_CAP`. Pass a positive integer to force a hard cap.
    """

    iis_timeout: int = 300
    max_iterations: int = 0
    batch_fraction: float = 0.10
    feasibility_timeout: int = 30
    skip_reduce: bool = False
    """Skip Step 3 (iterative removal) and Step 3.5 (add-back refinement).
    These are the Gurobi-heavy reduction steps; when the summarizer
    agent is the downstream consumer they add no value."""

    skip_relax: bool = False
    """Skip Step 7 (feasRelax numeric violations). On large models the
    fallback full-model relaxation can take minutes and time out."""

    skip_minimize: bool = False
    skip_classify: bool = False
    skip_grouping: bool = False
    skip_refine: bool = False

    reduce_target: int = 100
    """Target size for the deletion-filter reduction in agent-mode.
    Chinneck stops dropping constraints once ``|IIS| ≤ reduce_target``."""

    reduce_budget_seconds: int = 600
    """Wall-clock cap (seconds) for Step 4 when reduce_target is active.
    If Chinneck cannot reach the target in this time, the loop stops
    and the caller falls back to a text-level family-collapse of the
    original .ilp."""

    large_model_mode: bool = False
    """Force the large-model fast filter pipeline (LargeModelFilter)
    regardless of IIS size.  Equivalent to --fast-mode on the CLI."""

    large_model_threshold: int = 200
    """Auto-route to LargeModelFilter when |IIS| exceeds this value.
    Default: 200 constraints."""

    iis_method: int | None = None
    """Gurobi ``IISMethod`` parameter for Step 1 (0–3). ``None`` keeps
    Gurobi's automatic choice. Try 1 (conservative) or 2 (aggressive)
    when computeIIS is slow; 3 focuses on bound conflicts."""

    numeric_focus: int | None = None
    """Gurobi ``NumericFocus`` parameter for Step 1 (0–3). Higher values
    trade speed for numerical stability."""

    threads: int | None = None
    """Gurobi ``Threads`` parameter for Step 1. The IIS outer loop is
    sequential, but extra threads speed up each subproblem solve."""

    seed_ilp: Path | None = None
    """A previous run's ``.ilp`` whose constraint names seed today's
    candidate set. Verified still infeasible under today's data before
    use; a stale seed silently falls back to a fresh computeIIS."""

    iis_target: int | None = None
    """Callback-based early exit for Step 1: terminate ``computeIIS``
    once the live IIS-size upper bound drops to this value. The partial
    IIS is guaranteed infeasible; Step 4 minimizes it."""

    language: str = "en"
    """Output language for the Python-written report parts (``"en"`` /
    ``"ja"``). Resolved once on the CLI (explicit --lang ▸ OS locale ▸
    English) and threaded into the value-propagation trace and the
    report generator so the report is language-consistent."""

    skip_trace: bool = False
    """Skip Step 5.5 (value-propagation forcing-chain trace)."""

    trace_max_constraints: int = 30
    """Run the Step 5.5 trace only when ``|IIS| ≤`` this value. The
    trace is solver-free (pure interval arithmetic) but its narrative
    value drops sharply on large IISes."""


class Analyzer:
    """
    High-level orchestrator for the 8-step IIS analysis pipeline.

    Dependencies are injected via the constructor to keep the pipeline
    testable and swappable. Use :meth:`create` for the default wiring.
    """

    def __init__(
        self,
        iis_runner: IIISRunner,
        ilp_parser: IILPParser,
        constraint_remover: IConstraintRemover,
        batch_refiner: IBatchRefiner,
        deletion_filter: IDeletionFilter,
        large_model_filter: ILargeModelFilter,
        classifier: IClassifier,
        semantic_grouper: ISemanticGrouper,
        relaxer: IRelaxer,
        report_generator: IReportGenerator,
        propagator: IPropagator | None = None,
    ) -> None:
        self._iis_runner = iis_runner
        self._ilp_parser = ilp_parser
        self._constraint_remover = constraint_remover
        self._batch_refiner = batch_refiner
        self._deletion_filter = deletion_filter
        self._large_model_filter = large_model_filter
        self._classifier = classifier
        self._semantic_grouper = semantic_grouper
        self._relaxer = relaxer
        self._report_generator = report_generator
        self._propagator = propagator if propagator is not None else Propagator.create()

    @classmethod
    def create(cls) -> Analyzer:
        """Factory wiring the default implementations of each pipeline step."""
        return cls(
            iis_runner=IISRunner.create(),
            ilp_parser=ILPParser.create(),
            constraint_remover=ConstraintRemover.create(),
            batch_refiner=BatchRefiner.create(),
            deletion_filter=DeletionFilter.create(),
            large_model_filter=LargeModelFilter.create(),
            classifier=Classifier.create(),
            semantic_grouper=SemanticGrouper.create(),
            relaxer=Relaxer.create(),
            report_generator=ReportGenerator.create(),
        )

    # ─────────────────────────────────────────────────────────
    # Pipeline entry point
    # ─────────────────────────────────────────────────────────

    def run(
        self,
        lp_file: Path,
        ilp_file: Path | None = None,
        output_dir: Path | None = None,
        options: AnalysisOptions | None = None,
    ) -> Path:
        """
        Run the full pipeline and return the path to the generated report.

        Parameters
        ----------
        lp_file
            Path to the infeasible .lp model.
        ilp_file
            Pre-computed .ilp file. If ``None``, Step 1 computes it.
        output_dir
            Root output directory (defaults to ``<lp_file>.parent/iis_summary/``).
        options
            Runtime tuning parameters (see :class:`AnalysisOptions`).
        """
        opts = options or AnalysisOptions()
        out_dir = output_dir if output_dir is not None else lp_file.parent / "iis_summary"
        work_dir = out_dir / "iterations"
        out_dir.mkdir(parents=True, exist_ok=True)

        logger.info("IIS analysis starting: model=%s  output=%s", lp_file, out_dir)

        # ── Step 1 ─────────────────────────────────────────
        ilp_path, iis_result = self._step1_iis(lp_file, ilp_file, out_dir, opts)

        # ── Step 2 ─────────────────────────────────────────
        parsed = self._ilp_parser.parse(ilp_path)
        logger.info("Step 2: parsed %d IIS constraint(s)", parsed.constraint_count)
        if parsed.constraint_count == 0:
            raise AnalysisAbortedError(
                f"ILP file {ilp_path} contains no constraints — cannot proceed."
            )

        # ── Step 3 — staircase extender ────────────────────
        # When opts.max_iterations <= 0 (the default) we start with
        # ITERATION_INITIAL iterations and, if the model is still infeasible,
        # extend by ITERATION_STEP more — reusing the already-removed set —
        # until ITERATION_HARD_CAP is reached. A positive opts.max_iterations
        # disables the extender and is used verbatim.
        if opts.skip_reduce:
            logger.info("Step 3 skipped (--skip-reduce / --agent-mode).")
            removal = RemovalResult(
                success=False,
                iterations_performed=0,
                message="Skipped by --skip-reduce.",
            )
        elif opts.max_iterations > 0:
            removal = self._constraint_remover.run(
                base_lp_file=lp_file,
                parsed_ilp=parsed,
                work_dir=work_dir,
                max_iterations=opts.max_iterations,
                batch_fraction=opts.batch_fraction,
                feasibility_timeout=opts.feasibility_timeout,
            )
        else:
            removal = self._run_step3_staircase(lp_file, parsed, work_dir, opts)
        if removal.success:
            logger.info(
                "Step 3: root cause isolated in %d iteration(s); %d culprit(s)",
                removal.iterations_performed,
                len(removal.culprit_constraints),
            )
        elif not opts.skip_reduce:
            logger.warning("Step 3: %s", removal.message)

        # Step 3.5 (refinement) is intentionally deferred until after
        # Step 4 reduces the IIS — that way agent-mode runs on a large
        # IIS can still get a single-constraint pinpoint once the
        # reduction brings ``|IIS|`` under
        # ``AGENT_MODE_REFINE_IIS_THRESHOLD``. See the call site below.

        # ── Step 4 ─────────────────────────────────────────
        iis_names = list(parsed.constraints.keys())
        deletion = DeletionFilterResult(success=False, error_message="Skipped.")
        CHINNECK_SIZE_CUTOFF = 5 * opts.reduce_target
        need_reduction = len(iis_names) > opts.reduce_target
        chinneck_unhelpful = len(iis_names) > CHINNECK_SIZE_CUTOFF
        use_large_model_filter = (
            opts.large_model_mode or len(iis_names) > opts.large_model_threshold
        )

        # large_model_mode (--fast-mode) forces the fast pipeline regardless
        # of IIS size — even when |IIS| ≤ reduce_target where no Chinneck
        # reduction would normally run.
        if not opts.skip_minimize and (need_reduction or use_large_model_filter):
            if use_large_model_filter:
                logger.info(
                    "Step 4: |IIS|=%d → using LargeModelFilter (threshold=%d, "
                    "fast_mode=%s).",
                    len(iis_names),
                    opts.large_model_threshold,
                    opts.large_model_mode,
                )
                deletion = self._large_model_filter.minimize(
                    lp_file=lp_file,
                    iis_constraint_names=iis_names,
                    feasibility_timeout=opts.feasibility_timeout,
                    budget_seconds=float(opts.reduce_budget_seconds),
                )
                if deletion.success:
                    logger.info(
                        "Step 4 (fast): reduced IIS from %d to %d constraint(s) "
                        "in %.1fs (phases: %s).",
                        len(iis_names),
                        len(deletion.minimal_iis),
                        deletion.elapsed_seconds,
                        ", ".join(deletion.phases_run),
                    )
                else:
                    logger.warning("Step 4 (fast) failed: %s", deletion.error_message)
            elif not chinneck_unhelpful:
                deletion = self._deletion_filter.minimize(
                    lp_file=lp_file,
                    iis_constraint_names=iis_names,
                    feasibility_timeout=opts.feasibility_timeout,
                    target_size=opts.reduce_target,
                    budget_seconds=float(opts.reduce_budget_seconds),
                )
                if deletion.success:
                    logger.info(
                        "Step 4: reduced IIS from %d to %d constraint(s); "
                        "%d dropped (%.0f%%) in %.1fs.",
                        len(iis_names),
                        len(deletion.minimal_iis),
                        len(deletion.dropped_as_redundant),
                        deletion.reduction_ratio * 100,
                        deletion.elapsed_seconds,
                    )
                else:
                    logger.warning("Step 4 skipped: %s", deletion.error_message)
            else:
                logger.info(
                    "Step 4: |IIS|=%d > 5×target (%d); Chinneck skipped. "
                    "Family-collapse will be used to reduce the .ilp.",
                    len(iis_names),
                    opts.reduce_target,
                )
                deletion = DeletionFilterResult(
                    success=True,
                    minimal_iis=iis_names,
                    dropped_as_redundant=[],
                    iterations=0,
                    elapsed_seconds=0.0,
                    error_message=(
                        f"Chinneck skipped: |IIS|={len(iis_names)} > 5×target ({opts.reduce_target})."
                    ),
                )
        elif not opts.skip_minimize:
            logger.info(
                "Step 4: |IIS|=%d ≤ target=%d; no reduction needed.",
                len(iis_names),
                opts.reduce_target,
            )
            deletion = DeletionFilterResult(
                success=True,
                minimal_iis=iis_names,
                dropped_as_redundant=[],
                iterations=0,
                elapsed_seconds=0.0,
            )

        effective_iis = (
            deletion.minimal_iis if deletion.success and deletion.minimal_iis else iis_names
        )

        # Write a reduced .ilp file if reduction actually helped OR if
        # the IIS is still above target (fallback: family-collapse). The
        # summarizer downstream reads this file when it exists. We also
        # trim ``parsed.constraints`` to only the kept names so the
        # report appendix doesn't dump the full (huge) IIS.
        _, kept_names = self._maybe_write_reduced_ilp(
            parsed=parsed,
            effective_iis=effective_iis,
            original_iis_names=iis_names,
            target=opts.reduce_target,
            ilp_path=ilp_path,
            out_dir=out_dir,
            lp_file=lp_file,
        )
        if len(kept_names) < len(parsed.constraints):
            kept_set = set(kept_names)
            parsed.constraints = {
                name: body for name, body in parsed.constraints.items() if name in kept_set
            }
            logger.info(
                "Report appendix will include %d constraint(s) (reduced from %d).",
                len(parsed.constraints),
                len(iis_names),
            )

        # ── Step 3.5 — Batch refinement (deferred until post-reduction) ─
        # Runs here so that in agent-mode the IIS-direct path sees the
        # already-reduced ``parsed.constraints`` and can probe it for a
        # single root cause whenever the reduction brought the size
        # under ``AGENT_MODE_REFINE_IIS_THRESHOLD``.
        refinement = self._run_step35(
            lp_file=lp_file,
            parsed=parsed,
            removal=removal,
            work_dir=work_dir,
            opts=opts,
        )

        # ── Steps 5 + 6 ───────────────────────────────────
        # Both are read-only and parse the same LP. Load the model
        # once and share it so the 90 MB parse cost is paid once, not
        # twice. ``shared_model`` is ``None`` when both steps are
        # skipped, when gurobipy is unavailable, or when the LP can't
        # be read — each step falls back to its own ``gp.read`` in
        # that case (preserving today's standalone behavior).
        shared_model = None
        if not opts.skip_classify or not opts.skip_grouping:
            shared_model = self._load_shared_model(lp_file)

        classification = ClassificationResult(success=False, error_message="Skipped.")
        if not opts.skip_classify:
            classification = self._classifier.classify(
                lp_file=lp_file,
                iis_constraint_names=effective_iis,
                model=shared_model,
            )
            if classification.success:
                c = classification.counts
                logger.info(
                    "Step 5: data=%d  structure=%d  unknown=%d",
                    c["data"],
                    c["structure"],
                    c["unknown"],
                )
            else:
                logger.warning("Step 5 skipped: %s", classification.error_message)

        grouping = SemanticGroupResult(success=False, error_message="Skipped.")
        if not opts.skip_grouping:
            grouping = self._semantic_grouper.group(
                lp_file=lp_file,
                iis_constraint_names=effective_iis,
                model=shared_model,
            )
            if grouping.success:
                logger.info(
                    "Step 6: %d conflict subsystem(s); largest = %d",
                    grouping.group_count,
                    grouping.largest_group_size,
                )
            else:
                logger.warning("Step 6 skipped: %s", grouping.error_message)

        # ── Step 5.5 — Value-propagation forcing chain ─────
        # Solver-free interval arithmetic over the IIS rows: turns a
        # small all-STRUCTURE IIS into an ordered "what forces what"
        # chain ending at the exact contradiction. Reuses the shared
        # model (read-only) before it is disposed below.
        propagation = self._run_step55(
            lp_file=lp_file,
            effective_iis=effective_iis,
            classification=classification,
            shared_model=shared_model,
            opts=opts,
        )

        if shared_model is not None:
            self._dispose_model(shared_model)

        # ── Step 7 ─────────────────────────────────────────
        # Target the root cause when Step 3.5 isolated one; otherwise
        # fall back to the full effective IIS. Always include any
        # IIS-participating variable bounds (parsed.bounds.keys()) so
        # feasRelax can surface required bound changes alongside RHS
        # changes in a single pass.
        if opts.skip_relax:
            logger.info("Step 7 skipped (--skip-relax / --agent-mode).")
            relaxation = RelaxationResult(success=False, error_message="Skipped by --skip-relax.")
        else:
            relaxation_targets = (
                [refinement.root_cause]
                if refinement.has_root_cause and refinement.root_cause is not None
                else effective_iis
            )
            iis_bound_vars = list(parsed.bounds.keys())
            relaxation = self._relaxer.compute(
                lp_file=lp_file,
                constraint_names=relaxation_targets,
                timeout=opts.feasibility_timeout,
                bound_variable_names=iis_bound_vars,
            )
            if relaxation.success:
                logger.info(
                    "Step 7: total violation = %.4f across %d constraint(s) and %d bound(s)",
                    relaxation.total_violation,
                    len(relaxation.constraint_relaxations),
                    len(relaxation.variable_bound_relaxations),
                )
            else:
                logger.warning("Step 7 skipped: %s", relaxation.error_message)

        # ── Step 7b — indicator slack injection ───────────────────
        # feasRelax cannot relax general constraints; when the IIS
        # contains indicator constraints, compute their minimum RHS
        # deltas via the Gurobi-recommended slack-injection pattern.
        # One cheap solve — runs even in agent-mode.
        indicator_names = [
            m.split(": ", 1)[1]
            for m in (iis_result.nonlinear_iis_members if iis_result else [])
            if m.startswith("indicator:")
        ]
        if indicator_names:
            from iis_summarization.indicator_relaxation import (
                compute_indicator_relaxations,
            )

            ind = compute_indicator_relaxations(
                lp_file=lp_file,
                gen_constr_names=indicator_names,
                timeout=opts.feasibility_timeout,
            )
            if ind.success and ind.constraint_relaxations:
                relaxation.indicator_relaxations = ind.constraint_relaxations
                relaxation.indicator_fix_verified = ind.fix_verified
                relaxation.indicator_fix_message = ind.fix_verification_message
                logger.info(
                    "Step 7b: %d indicator relaxation(s) computed "
                    "(fix_verified=%s).",
                    len(ind.constraint_relaxations),
                    ind.fix_verified,
                )
            elif not ind.success:
                logger.warning("Step 7b failed: %s", ind.error_message)

        # ── Step 8 ─────────────────────────────────────────
        report_path = self._report_generator.generate(
            lp_file=lp_file,
            parsed_ilp=parsed,
            removal_result=removal,
            relaxation_result=relaxation,
            classification_result=classification,
            grouping_result=grouping,
            output_dir=out_dir,
            refinement_result=refinement,
            iis_result=iis_result,
            language=opts.language,
            propagation_result=propagation,
        )
        logger.info("Analysis complete: report=%s", report_path)
        return report_path

    def _run_step55(
        self,
        lp_file: Path,
        effective_iis: list[str],
        classification: ClassificationResult,
        shared_model: object | None,
        opts: AnalysisOptions,
    ) -> PropagationTrace:
        """Step 5.5 dispatch — the value-propagation forcing chain.

        Gated to the case the trace exists for: a small IIS with no
        single DATA constraint already explaining it. A DATA constraint
        is infeasible in isolation, so the existing classifier output is
        already actionable and the trace would add noise.
        """
        if opts.skip_trace:
            return PropagationTrace(success=False, error_message="Skipped by --skip-trace.")

        n = len(effective_iis)
        if n == 0 or n > opts.trace_max_constraints:
            logger.info(
                "Step 5.5 skipped: |IIS|=%d outside trace range (1..%d).",
                n,
                opts.trace_max_constraints,
            )
            return PropagationTrace(
                success=False,
                error_message=f"|IIS|={n} outside trace range.",
            )

        if classification.success and classification.data_problems:
            logger.info(
                "Step 5.5 skipped: %d DATA constraint(s) already explain the conflict.",
                len(classification.data_problems),
            )
            return PropagationTrace(
                success=False,
                error_message="DATA constraint already explains the conflict.",
            )

        propagation = self._propagator.trace(
            lp_file=lp_file,
            iis_constraint_names=effective_iis,
            model=shared_model,
            language=opts.language,
        )
        if propagation.success and propagation.reached_contradiction:
            logger.info(
                "Step 5.5: forcing chain isolated a contradiction on `%s` "
                "(%d step(s)).",
                propagation.contradiction.variable if propagation.contradiction else "?",
                len(propagation.steps),
            )
        elif propagation.success:
            logger.info(
                "Step 5.5: no single contradiction — conflict is combinatorial."
            )
        else:
            logger.info("Step 5.5 unavailable: %s", propagation.error_message)
        return propagation

    @staticmethod
    def _load_shared_model(lp_file: Path) -> object | None:
        """Load *lp_file* into a Gurobi model for read-only sharing.

        Returns ``None`` (and logs a warning) when gurobipy is
        unavailable or the read fails — callers fall back to their own
        ``gp.read`` so the pipeline degrades gracefully.
        """
        from iis_summarization._gurobi import import_gurobi
        from iis_summarization.errors import GurobiUnavailableError

        try:
            gp, _ = import_gurobi()
        except GurobiUnavailableError as exc:
            logger.warning("Shared-model load skipped: %s", exc)
            return None
        if not lp_file.exists():
            logger.warning("Shared-model load skipped: LP not found at %s", lp_file)
            return None
        try:
            model = gp.read(str(lp_file))
            model.setParam("OutputFlag", 0)
            model.update()
            return model
        except gp.GurobiError as exc:
            logger.warning("Shared-model load failed: %s", exc)
            return None

    @staticmethod
    def _dispose_model(model: object) -> None:
        """Best-effort model disposal; suppresses Gurobi errors."""
        import contextlib

        from iis_summarization._gurobi import import_gurobi
        from iis_summarization.errors import GurobiUnavailableError

        try:
            gp, _ = import_gurobi()
        except GurobiUnavailableError:
            return
        with contextlib.suppress(AttributeError, gp.GurobiError):
            model.dispose()  # type: ignore[attr-defined]

    def _run_step35(
        self,
        lp_file: Path,
        parsed: ParsedILP,
        removal: RemovalResult,
        work_dir: Path,
        opts: AnalysisOptions,
    ) -> BatchRefinementResult:
        """Step 3.5 dispatch.

        Two paths converge on the same add-back algorithm:

        1. **Normal:** ``--skip-reduce`` is off and Step 3 produced a
           culprit batch. Refine the batch.
        2. **Agent-mode direct:** ``--skip-reduce`` is on (Step 3 skipped)
           AND ``|IIS| <= AGENT_MODE_REFINE_IIS_THRESHOLD``. Refine the
           IIS itself. Requires that removing the entire IIS restores
           feasibility; if multiple disjoint IISes exist, this check
           fails and refinement is skipped.
        """
        if opts.skip_refine:
            return BatchRefinementResult(success=False, error_message="Skipped by --skip-refine.")

        # Normal path: refine Step 3's culprit batch.
        if not opts.skip_reduce:
            if removal.success and len(removal.culprit_constraints) >= 2:
                refinement = self._batch_refiner.refine(
                    base_lp_file=lp_file,
                    batch=removal.culprit_constraints,
                    parsed_ilp=parsed,
                    work_dir=work_dir,
                    feasibility_timeout=opts.feasibility_timeout,
                )
                self._log_step35(refinement)
                return refinement
            if removal.success and removal.culprit_constraints:
                # Single-constraint batch is already minimal.
                return BatchRefinementResult(
                    success=True,
                    root_cause=removal.culprit_constraints[0],
                )
            return BatchRefinementResult(
                success=False,
                error_message="Skipped (Step 3 did not reach feasibility).",
            )

        # Agent-mode direct path: probe the IIS itself.
        iis_names = list(parsed.constraints.keys())
        if len(iis_names) > AGENT_MODE_REFINE_IIS_THRESHOLD:
            return BatchRefinementResult(
                success=False,
                error_message=(
                    f"Skipped (agent-mode, |IIS|={len(iis_names)} > "
                    f"{AGENT_MODE_REFINE_IIS_THRESHOLD})."
                ),
            )
        if len(iis_names) <= 1:
            return BatchRefinementResult(
                success=True,
                root_cause=iis_names[0] if iis_names else None,
            )

        work_dir.mkdir(parents=True, exist_ok=True)
        iis_removed_lp = work_dir / f"{lp_file.stem}_iis_removed.lp"
        if not create_modified_lp(lp_file, iis_names, iis_removed_lp):
            return BatchRefinementResult(
                success=False,
                error_message=f"Could not write IIS-removed probe LP at {iis_removed_lp}.",
            )

        precheck = test_feasibility(iis_removed_lp, timeout=opts.feasibility_timeout)
        if not precheck.is_feasible:
            msg = (
                f"Removing the IIS did not restore feasibility "
                f"(status={precheck.model_status}); multiple IISes likely, "
                "skipping direct refinement."
            )
            logger.info("Step 3.5 (IIS-direct): %s", msg)
            return BatchRefinementResult(success=False, error_message=msg)

        logger.info(
            "Step 3.5 (IIS-direct): probing %d IIS constraint(s)",
            len(iis_names),
        )
        refinement = self._batch_refiner.refine(
            base_lp_file=lp_file,
            batch=iis_names,
            parsed_ilp=parsed,
            work_dir=work_dir,
            feasibility_timeout=opts.feasibility_timeout,
        )
        self._log_step35(refinement)
        return refinement

    @staticmethod
    def _log_step35(refinement: BatchRefinementResult) -> None:
        if refinement.has_root_cause:
            logger.info(
                "Step 3.5: root cause isolated -> %s (elapsed=%.2fs)",
                refinement.root_cause,
                refinement.elapsed_seconds,
            )
        elif refinement.success:
            logger.info(
                "Step 3.5: no single root cause; joint culprits = %d constraint(s)",
                len(refinement.joint_culprits),
            )
        else:
            logger.warning("Step 3.5 skipped: %s", refinement.error_message)

    def _run_step3_staircase(
        self,
        lp_file: Path,
        parsed: ParsedILP,
        work_dir: Path,
        opts: AnalysisOptions,
    ) -> RemovalResult:
        """Run Step 3 with an auto-extending iteration budget.

        Starts at :data:`ITERATION_INITIAL` iterations and, if not yet
        feasible, extends by :data:`ITERATION_STEP` more each attempt until
        the model is feasible, no more constraints remain to remove, or the
        cumulative count reaches :data:`ITERATION_HARD_CAP`.
        """
        removed_so_far: list[str] = []
        total_iters = 0
        last_removal: RemovalResult | None = None
        attempt = 0

        while total_iters < ITERATION_HARD_CAP:
            attempt += 1
            step_iters = min(
                ITERATION_INITIAL if attempt == 1 else ITERATION_STEP,
                ITERATION_HARD_CAP - total_iters,
            )
            logger.info(
                "Step 3 attempt %d: running %d iteration(s) (cumulative budget %d/%d)",
                attempt,
                step_iters,
                total_iters + step_iters,
                ITERATION_HARD_CAP,
            )

            last_removal = self._constraint_remover.run(
                base_lp_file=lp_file,
                parsed_ilp=parsed,
                work_dir=work_dir,
                max_iterations=step_iters,
                batch_fraction=opts.batch_fraction,
                feasibility_timeout=opts.feasibility_timeout,
                already_removed=removed_so_far,
                iteration_offset=total_iters,
            )
            removed_so_far = list(last_removal.all_removed_constraints)
            total_iters += step_iters

            if last_removal.success:
                return last_removal
            if "No more constraints available to remove." in last_removal.message:
                return last_removal

        assert last_removal is not None
        return RemovalResult(
            success=False,
            iterations_performed=last_removal.iterations_performed,
            culprit_constraints=last_removal.culprit_constraints,
            all_removed_constraints=last_removal.all_removed_constraints,
            feasible_model_file=last_removal.feasible_model_file,
            final_solve_time=last_removal.final_solve_time,
            message=(f"Reached hard cap of {ITERATION_HARD_CAP} iterations without feasibility."),
        )

    def _maybe_write_reduced_ilp(
        self,
        parsed: ParsedILP,
        effective_iis: list[str],
        original_iis_names: list[str],
        target: int,
        ilp_path: Path,
        out_dir: Path,
        lp_file: Path | None = None,
    ) -> tuple[Path | None, list[str]]:
        """Emit a reduced ``<stem>_iis_reduced.ilp`` if beneficial.

        Returns ``(path, kept_names)``:

        - ``path`` is the file path of the reduced ``.ilp`` (or ``None``
          if no reduction was needed / possible).
        - ``kept_names`` is the list of constraint names that ended up
          in the reduced file — or the original IIS if no reduction
          was produced. Callers use this to trim the report appendix
          so it never dumps 188k constraints.

        Reduction pipeline:

        1. If Chinneck already trimmed ``effective_iis`` below
           ``original_iis_names``, write those verbatim.
        2. If the result is still larger than ``target``, fall back to
           *family-collapse* (one representative per constraint-name
           template). Further cap at ``target`` families so the file
           is always ≤ ``target`` constraints.
        """
        from iis_summarization.ilp_reducer import (
            family_collapse,
            verify_subset_infeasible,
            write_subset_ilp,
        )

        out_path = out_dir / f"{ilp_path.stem}_reduced.ilp"

        if 0 < len(effective_iis) < len(original_iis_names) and len(effective_iis) <= target:
            # Step 4 produced a smaller IIS that already fits the
            # target — write it verbatim. If it is bigger, the
            # family-collapse block below overwrites the file.
            write_subset_ilp(
                parsed_ilp=parsed,
                keep_names=effective_iis,
                out_path=out_path,
                header=(
                    f"Reduced IIS: {len(effective_iis)} constraint(s) "
                    f"from {len(original_iis_names)} (Chinneck deletion filter)."
                ),
            )
            logger.info(
                "Reduced .ilp written: %s (%d constraints).",
                out_path,
                len(effective_iis),
            )
            return out_path, effective_iis

        if len(effective_iis) > target:
            # Try increasing numbers of representatives per family
            # until the reduced subset preserves infeasibility.
            max_reps = 1
            capped: list[str] = []
            verified = False
            for max_reps in (1, 2, 3, 5):
                families = family_collapse(effective_iis, max_reps_per_family=max_reps)
                capped = families[:target]
                if lp_file is not None and lp_file.exists():
                    if verify_subset_infeasible(lp_file, capped, timeout=30):
                        verified = True
                        if max_reps > 1:
                            logger.info(
                                "Family-collapse with max_reps=%d "
                                "preserves infeasibility (%d constraints).",
                                max_reps,
                                len(capped),
                            )
                        break
                    logger.info(
                        "Family-collapse with max_reps=%d became feasible "
                        "— retrying with more representatives.",
                        max_reps,
                    )
                else:
                    # No LP file available to verify; use max_reps=1
                    # and note it in the header.
                    break

            is_valid_iis = "is" if verified else "may NOT be"
            write_subset_ilp(
                parsed_ilp=parsed,
                keep_names=capped,
                out_path=out_path,
                header=(
                    f"Family-collapsed IIS: {len(capped)} representative "
                    f"constraint(s) from {len(effective_iis)} in the "
                    f"full IIS (max {max_reps} per name template, "
                    f"truncated to target size {target}). This file "
                    f"{is_valid_iis} a mathematically valid infeasible "
                    "subset — use for structural analysis."
                ),
            )
            logger.info(
                "Family-collapsed .ilp written: %s (%d constraints; "
                "max_reps=%d; verified=%s; target=%d).",
                out_path,
                len(capped),
                max_reps,
                verified,
                target,
            )
            return out_path, capped

        # No reduction needed — |IIS| ≤ target.
        return None, effective_iis

    def _step1_iis(
        self,
        lp_file: Path,
        ilp_file: Path | None,
        out_dir: Path,
        opts: AnalysisOptions,
    ) -> tuple[Path, IISRunResult | None]:
        """Return ``(ilp_path, iis_result)``; *iis_result* is ``None``
        when a pre-computed or cached ILP was used (no fresh computeIIS)."""
        if ilp_file is not None:
            logger.info("Step 1: using pre-computed ILP file: %s", ilp_file)
            return ilp_file, None

        if opts.seed_ilp is not None and not opts.seed_ilp.exists():
            logger.warning(
                "Step 1: --seed-ilp %s does not exist — running a fresh "
                "computeIIS.",
                opts.seed_ilp,
            )
        if opts.seed_ilp is not None and opts.seed_ilp.exists():
            from iis_summarization.iis_runner import run_seeded_iis

            seed_names = list(self._ilp_parser.parse(opts.seed_ilp).constraints.keys())
            seeded = run_seeded_iis(
                lp_file=lp_file,
                seed_names=seed_names,
                output_dir=out_dir,
                feasibility_timeout=opts.feasibility_timeout,
            )
            if seeded is not None and seeded.ilp_file is not None:
                logger.info(
                    "Step 1: warm-started from seed %s (computeIIS skipped).",
                    opts.seed_ilp,
                )
                return seeded.ilp_file, seeded
            logger.info(
                "Step 1: seed %s rejected (stale or unusable) — running "
                "a fresh computeIIS.",
                opts.seed_ilp,
            )

        sibling_ilp = lp_file.with_suffix(".ilp")
        if sibling_ilp.exists():
            if sibling_ilp.stat().st_mtime >= lp_file.stat().st_mtime:
                logger.info(
                    "Step 1: reusing sibling ILP %s (skipping computeIIS)",
                    sibling_ilp,
                )
                return sibling_ilp, None
            logger.info(
                "Step 1: sibling ILP %s is older than LP; ignoring it and "
                "recomputing IIS to ensure the diagnosis matches the current model",
                sibling_ilp,
            )

        iis_result = self._iis_runner.run(
            lp_file=lp_file,
            timeout_seconds=opts.iis_timeout,
            output_dir=out_dir,
            iis_method=opts.iis_method,
            numeric_focus=opts.numeric_focus,
            threads=opts.threads,
            iis_target=opts.iis_target,
        )
        if not iis_result.success or iis_result.ilp_file is None:
            raise AnalysisAbortedError(
                "IIS computation failed. "
                f"reason={iis_result.error_message!r} "
                f"timed_out={iis_result.timed_out} "
                f"status={iis_result.model_status}"
            )
        logger.info(
            "Step 1: IIS computed in %.2fs -> %s "
            "(%d constraint(s), %d bound(s) in IIS attributes)",
            iis_result.elapsed_seconds,
            iis_result.ilp_file,
            len(iis_result.iis_constraints),
            len(iis_result.iis_bounds),
        )
        if iis_result.has_default_lb_issues:
            logger.warning(
                "Step 1: %d variable(s) with default LB=0 in IIS — "
                "verify these are intentional (Gurobi defaults LB to 0)",
                len(iis_result.has_default_lb_issues),
            )

        # All generated files stay inside the single output folder
        # (default `iis_summary/`) — the fresh .ilp is cached there and
        # nothing is written next to the model file.
        return iis_result.ilp_file, iis_result


def run_analysis(
    lp_file: str | Path,
    ilp_file: str | Path | None = None,
    output_dir: str | Path | None = None,
    iis_timeout: int = 300,
    max_iterations: int = 0,
    batch_fraction: float = 0.10,
    feasibility_timeout: int = 30,
    skip_reduce: bool = False,
    skip_relax: bool = False,
    skip_minimize: bool = False,
    skip_classify: bool = False,
    skip_grouping: bool = False,
    skip_refine: bool = False,
    large_model_mode: bool = False,
    large_model_threshold: int = 200,
) -> Path:
    """Functional convenience wrapper around :class:`Analyzer`."""
    options = AnalysisOptions(
        iis_timeout=iis_timeout,
        max_iterations=max_iterations,
        batch_fraction=batch_fraction,
        feasibility_timeout=feasibility_timeout,
        skip_reduce=skip_reduce,
        skip_relax=skip_relax,
        skip_minimize=skip_minimize,
        skip_classify=skip_classify,
        skip_grouping=skip_grouping,
        skip_refine=skip_refine,
        large_model_mode=large_model_mode,
        large_model_threshold=large_model_threshold,
    )
    return Analyzer.create().run(
        lp_file=Path(lp_file),
        ilp_file=Path(ilp_file) if ilp_file is not None else None,
        output_dir=Path(output_dir) if output_dir is not None else None,
        options=options,
    )
