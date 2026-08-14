"""Command-line entry point: ``python -m solve_tuning`` / ``solve-tuning``."""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

from .analyzer import AnalysisOptions, run_analysis
from .i18n import resolve_language


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="solve-tuning",
        description="Explain a Gurobi solver log and recommend tuning changes.",
    )
    p.add_argument("log_file", help="Path to a Gurobi solver log (text)")
    p.add_argument(
        "--lp", default=None, metavar="MODEL",
        help="Model file (.lp/.mps) — adds exact coefficient ranges and pinpoints "
        "where the extreme coefficients are (needs gurobipy)",
    )
    p.add_argument(
        "--baseline", default=None, metavar="LOG",
        help="A second (earlier) Gurobi log to compare against — shows whether gap, "
        "runtime, nodes, and status improved",
    )
    p.add_argument(
        "--output-dir", "-o", default=None,
        help="Report directory (default: the run's <debug>/solve_tuning/ or next to the log)",
    )
    p.add_argument(
        "--lang", default="auto",
        help="Report language: auto (default — detect OS locale), en, or ja",
    )
    p.add_argument("--log-level", default="INFO", choices=["DEBUG", "INFO", "WARNING", "ERROR"])
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(
        level=getattr(logging, args.log_level),
        format="%(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )
    options = AnalysisOptions(
        output_dir=Path(args.output_dir) if args.output_dir else None,
        language=resolve_language(args.lang),
        lp_file=Path(args.lp) if args.lp else None,
        baseline_log=Path(args.baseline) if args.baseline else None,
    )
    try:
        report_path = run_analysis(args.log_file, options)
    except (FileNotFoundError, RuntimeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    print(report_path)
    return 0
