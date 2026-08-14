"""
cli.py
──────
Single unified CLI entry point for the iis_summarization package.

Exposed via the ``iis-analyze`` console script (configured in
``pyproject.toml``). Usage::

    iis-analyze path/to/model.lp [options]
    python -m iis_summarization path/to/model.lp [options]
"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

from iis_summarization.analyzer import AnalysisOptions, Analyzer
from iis_summarization.errors import IISSummarizationError
from iis_summarization.i18n import resolve_language
from iis_summarization.logging_config import configure_logging


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="iis-analyze",
        description=(
            "IIS Infeasibility Analysis — diagnose infeasible Gurobi "
            "LP/MIP models and produce a ranked remediation report."
        ),
    )
    parser.add_argument(
        "lp_file",
        type=Path,
        help="Path to the infeasible .lp model (required).",
    )
    parser.add_argument(
        "--ilp",
        type=Path,
        default=None,
        metavar="FILE",
        help="Pre-computed .ilp file. If omitted, Step 1 computes it.",
    )
    parser.add_argument(
        "--output-dir",
        "-o",
        type=Path,
        default=None,
        metavar="DIR",
        help="Output directory (default: <lp_dir>/iis_summary/).",
    )
    parser.add_argument(
        "--iis-timeout",
        type=int,
        default=300,
        metavar="SEC",
        help="IIS computation timeout in seconds (default: 300).",
    )
    parser.add_argument(
        "--max-iter",
        type=int,
        default=0,
        metavar="N",
        help=(
            "Maximum iterations for the removal heuristic. "
            "Default 0 = auto-scale from IIS size and --batch-fraction "
            "(targets ~95%% IIS coverage). Pass a positive integer to "
            "force a fixed cap."
        ),
    )
    parser.add_argument(
        "--batch-fraction",
        type=float,
        default=0.10,
        metavar="FRAC",
        help=("Fraction of remaining constraints removed per iteration (default: 0.10)."),
    )
    parser.add_argument(
        "--feasibility-timeout",
        type=int,
        default=30,
        metavar="SEC",
        help="Per-trial Gurobi TimeLimit for Steps 3/4 (default: 30).",
    )
    parser.add_argument(
        "--skip-minimize",
        action="store_true",
        help="Skip Chinneck's deletion filter (Step 4).",
    )
    parser.add_argument(
        "--skip-classify",
        action="store_true",
        help="Skip DATA/STRUCTURE classification (Step 5).",
    )
    parser.add_argument(
        "--skip-grouping",
        action="store_true",
        help="Skip semantic grouping (Step 6).",
    )
    parser.add_argument(
        "--skip-refine",
        action="store_true",
        help="Skip batch refinement / root-cause isolation (Step 3.5).",
    )
    parser.add_argument(
        "--skip-reduce",
        action="store_true",
        help=(
            "Skip iterative reduction (Steps 3 and 3.5). "
            "Use when downstream only needs the raw IIS."
        ),
    )
    parser.add_argument(
        "--skip-relax",
        action="store_true",
        help="Skip feasRelax numeric violation step (Step 7).",
    )
    parser.add_argument(
        "--agent-mode",
        action="store_true",
        help=(
            "Produce the minimal output needed by the summarizer "
            "subagent: compute IIS, parse it, run Chinneck's deletion "
            "filter with --reduce-target and --reduce-budget as early-"
            "exit conditions, and emit a reduced .ilp file alongside "
            "the report. Equivalent to --skip-reduce --skip-relax "
            "--skip-classify --skip-grouping --skip-refine (Step 4 "
            "stays on). Fast path for use through the Claude Code "
            "skill orchestrator."
        ),
    )
    parser.add_argument(
        "--reduce-target",
        type=int,
        default=100,
        metavar="N",
        help=(
            "Stop Chinneck's deletion filter once the surviving IIS "
            "has this many constraints or fewer. Default: 100."
        ),
    )
    parser.add_argument(
        "--reduce-budget",
        type=int,
        default=600,
        metavar="SEC",
        help=(
            "Wall-clock cap for the deletion-filter reduction. If the "
            "budget expires before reaching --reduce-target, the tool "
            "falls back to a text-level family-collapse of the IIS. "
            "Default: 600 (10 minutes)."
        ),
    )
    parser.add_argument(
        "--fast-mode",
        action="store_true",
        help=(
            "Force the large-model fast filter pipeline (rule-based → "
            "Farkas → elastic → QuickXplain) regardless of IIS size. "
            "Recommended for models with |IIS| > 200. Combines with "
            "--agent-mode."
        ),
    )
    parser.add_argument(
        "--large-model-threshold",
        type=int,
        default=200,
        metavar="N",
        help=(
            "Automatically activate the fast filter pipeline when the "
            "IIS has more than N constraints. Default: 200."
        ),
    )
    parser.add_argument(
        "--enumerate-iises",
        action="store_true",
        help=(
            "Find multiple IISes via remove-and-recompute. Skips the "
            "normal pipeline and instead loops: solve, computeIIS, "
            "record, remove those constraints, repeat. Writes one "
            "<stem>_iis_NN.ilp per IIS plus a <stem>_iis_enumeration.md "
            "summary that groups by constraint-name template. Use when "
            "the standard report says 'Multiple IISes detected'."
        ),
    )
    parser.add_argument(
        "--max-iises",
        type=int,
        default=10,
        metavar="N",
        help="Cap on number of IISes for --enumerate-iises (default: 10).",
    )
    parser.add_argument(
        "--relax-instead-of-remove",
        action="store_true",
        help=(
            "For --enumerate-iises: loosen each found IIS's RHS values "
            "instead of deleting the constraints, then remove a single "
            "member if the same IIS recurs. Reveals IISes that OVERLAP "
            "already-found ones (removal hides them), per Gurobi's "
            "guidance."
        ),
    )
    parser.add_argument(
        "--enumerate-budget",
        type=int,
        default=3600,
        metavar="SEC",
        help="Total wall-clock budget for --enumerate-iises (default: 3600).",
    )
    parser.add_argument(
        "--iis-method",
        type=int,
        default=None,
        choices=[0, 1, 2, 3],
        metavar="N",
        help=(
            "Gurobi IISMethod parameter. 0/1 are alternative algorithms "
            "(1 is often faster on hard models), 2 ignores the time "
            "limit until an IIS is found, 3 focuses on bound conflicts. "
            "Default: Gurobi automatic (-1)."
        ),
    )
    parser.add_argument(
        "--numeric-focus",
        type=int,
        default=None,
        choices=[0, 1, 2, 3],
        metavar="N",
        help=(
            "Gurobi NumericFocus parameter — higher values trade speed "
            "for numerical stability. Use 2-3 when the model is "
            "numerically delicate. Default: Gurobi automatic (0)."
        ),
    )
    parser.add_argument(
        "--seed-ilp",
        type=Path,
        default=None,
        metavar="PATH",
        help=(
            "Warm-start with a previous run's .ilp: its constraint names "
            "are verified still infeasible under TODAY's data, and if so "
            "computeIIS is skipped entirely (the reduction steps minimize "
            "from the seed). A stale seed falls back to a normal run. "
            "Recommended for daily runs on structurally identical models."
        ),
    )
    parser.add_argument(
        "--threads",
        type=int,
        default=None,
        metavar="N",
        help=(
            "Gurobi Threads parameter for Step 1. The IIS outer loop is "
            "sequential, but extra threads speed up each subproblem "
            "solve on large models. Default: Gurobi automatic."
        ),
    )
    parser.add_argument(
        "--iis-target",
        type=int,
        default=None,
        metavar="N",
        help=(
            "Terminate computeIIS early (via the IIS callback) once the "
            "live IIS-size upper bound drops to N. The partial IIS is "
            "guaranteed infeasible — Step 4 minimizes it. Smarter than a "
            "blind --iis-timeout for very large models."
        ),
    )
    parser.add_argument(
        "--skip-trace",
        action="store_true",
        help="Skip the value-propagation forcing-chain trace (Step 5.5).",
    )
    parser.add_argument(
        "--trace-max-constraints",
        type=int,
        default=30,
        metavar="N",
        help=(
            "Run the Step 5.5 value trace only when the IIS has at most "
            "N constraints (default: 30). The trace is solver-free."
        ),
    )
    parser.add_argument(
        "--lang",
        default="auto",
        metavar="LANG",
        help=(
            "Output language for the report (default: auto — detect the "
            "OS locale from LC_ALL/LC_MESSAGES/LANG and use Japanese when "
            "it names a ja locale, English otherwise). Pass 'en' or 'ja' "
            "to force a language."
        ),
    )
    parser.add_argument(
        "--log-level",
        default=None,
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
        help=(
            "Logging level (default: INFO; WARNING in --agent-mode so the "
            "orchestrating LLM does not pay tokens for progress logs)."
        ),
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    """CLI entry point. Returns a process exit code."""
    parser = _build_parser()
    args = parser.parse_args(argv)

    # In --agent-mode the stdout/stderr stream lands in an LLM context
    # window, so progress logs cost tokens on every invocation. Default
    # to WARNING there; an explicit --log-level always wins.
    if args.log_level is None:
        level_name = "WARNING" if args.agent_mode else "INFO"
    else:
        level_name = args.log_level
    configure_logging(level=getattr(logging, level_name))
    logger = logging.getLogger("iis_summarization.cli")

    if level_name in ("WARNING", "ERROR"):
        # Gurobi prints its own console banner ("Read LP format model...",
        # 3 lines per sub-model read) outside Python logging — on a large
        # model the Chinneck/QuickXplain loops read hundreds of sub-models.
        # Silence the default environment globally in quiet mode.
        try:
            import gurobipy as gp

            gp.setParam("OutputFlag", 0)
        except Exception:  # noqa: BLE001 — quieting is best-effort only
            pass

    lp_path: Path = args.lp_file
    if not lp_path.exists():
        logger.error("LP file not found: %s", lp_path)
        return 2

    # --enumerate-iises short-circuits the normal pipeline: we want
    # the multi-IIS loop, not a single-IIS Verdict/Why/Fix report.
    if args.enumerate_iises:
        from iis_summarization.enumeration import (
            EnumerationOptions,
            enumerate_iises,
            write_enumeration_summary,
        )

        out_dir = args.output_dir if args.output_dir else lp_path.parent / "iis_summary"
        out_dir.mkdir(parents=True, exist_ok=True)
        enum_result = enumerate_iises(
            lp_file=lp_path,
            output_dir=out_dir,
            options=EnumerationOptions(
                max_iises=args.max_iises,
                budget_seconds=float(args.enumerate_budget),
                iis_timeout=args.iis_timeout,
                feasibility_timeout=args.feasibility_timeout,
                relax_instead_of_remove=args.relax_instead_of_remove,
            ),
        )
        summary_path = write_enumeration_summary(
            result=enum_result,
            lp_file=lp_path,
            output_dir=out_dir,
            language=resolve_language(args.lang),
        )
        logger.info(
            "Enumeration: %d IIS(es) found (%s). Summary: %s",
            enum_result.iis_count,
            enum_result.terminated_reason,
            summary_path,
        )
        return 0 if enum_result.success else 1

    # Auto-reuse a cached .ilp. Gurobi's computeIIS on a large model
    # can take 10+ minutes and its TimeLimit does not always interrupt
    # the computation cleanly; once the .ilp exists we should never
    # recompute it. If the caller did not pass --ilp explicitly and a
    # cached file exists at the conventional output path, use it.
    # An explicit --seed-ilp means the user wants today's data verified
    # against a previous IIS — the cached-.ilp shortcut would silently
    # reuse stale constraint bodies, so it is skipped in that case.
    if args.ilp is None and args.seed_ilp is None:
        candidate_dir = args.output_dir if args.output_dir else lp_path.parent / "iis_summary"
        candidate = candidate_dir / f"{lp_path.stem}_iis.ilp"
        if candidate.exists():
            logger.info(
                "Reusing cached IIS at %s (pass --ilp explicitly to override).",
                candidate,
            )
            args.ilp = candidate

    # --agent-mode skips the Gurobi-heavy steps that the summarizer
    # agent doesn't consume:
    #   - Step 3 (iterative removal):   slow batch heuristic
    #   - Step 7 (feasRelax):           seconds-to-minutes on large LPs
    # but keeps the steps that produce signal for the report:
    #   - Step 3.5 (refine, IIS-direct path):  may name a single root cause
    #   - Step 4 (Chinneck reduction):         produces the reduced .ilp
    #   - Step 5 (DATA/STRUCTURE labels):      cheap with shared model
    #   - Step 6 (conflict subsystems):        cheap with shared model
    if args.agent_mode:
        args.skip_reduce = True
        args.skip_relax = True
        # skip_minimize / skip_classify / skip_grouping / skip_refine
        # all stay False so those diagnostic steps run by default.

    options = AnalysisOptions(
        iis_timeout=args.iis_timeout,
        max_iterations=args.max_iter,
        batch_fraction=args.batch_fraction,
        feasibility_timeout=args.feasibility_timeout,
        skip_reduce=args.skip_reduce,
        skip_relax=args.skip_relax,
        skip_minimize=args.skip_minimize,
        skip_classify=args.skip_classify,
        skip_grouping=args.skip_grouping,
        skip_refine=args.skip_refine,
        reduce_target=args.reduce_target,
        reduce_budget_seconds=args.reduce_budget,
        large_model_mode=args.fast_mode,
        large_model_threshold=args.large_model_threshold,
        iis_method=args.iis_method,
        numeric_focus=args.numeric_focus,
        threads=args.threads,
        seed_ilp=args.seed_ilp,
        iis_target=args.iis_target,
        language=resolve_language(args.lang),
        skip_trace=args.skip_trace,
        trace_max_constraints=args.trace_max_constraints,
    )

    try:
        report = Analyzer.create().run(
            lp_file=lp_path,
            ilp_file=args.ilp,
            output_dir=args.output_dir,
            options=options,
        )
    except IISSummarizationError as exc:
        logger.error("Analysis failed: %s", exc)
        return 1

    logger.info("Report written to: %s", report)
    # Plain-stdout contract for the skill orchestrator: the report path is
    # always printed even at WARNING level. Sibling artifacts live next to
    # it (<stem>_iis_reduced.ilp, <stem>_agent_context.txt).
    print(report)
    return 0


if __name__ == "__main__":
    sys.exit(main())
