"""
feasibility.py
──────────────
Helper module (not a pipeline step): tests whether an LP file is
feasible within a time budget. Used by :mod:`constraint_remover` and
:mod:`deletion_filter`.
"""

from __future__ import annotations

import contextlib
import logging
import time
from pathlib import Path

from iis_summarization._gurobi import import_gurobi
from iis_summarization.errors import GurobiUnavailableError
from iis_summarization.interfaces import IFeasibilityTester
from iis_summarization.models import FeasibilityResult

logger = logging.getLogger(__name__)


class FeasibilityTester(IFeasibilityTester):
    """Default implementation of :class:`IFeasibilityTester`."""

    @classmethod
    def create(cls) -> IFeasibilityTester:
        """Factory returning an :class:`IFeasibilityTester`."""
        return cls()

    def test(self, lp_file: Path, timeout: int) -> FeasibilityResult:
        return _test_feasibility_impl(lp_file, timeout)


def test_feasibility(
    lp_file: str | Path,
    timeout: int = 30,
) -> FeasibilityResult:
    """Optimize *lp_file* with a time limit and return feasibility status."""
    return FeasibilityTester.create().test(Path(lp_file), timeout)


def _test_feasibility_impl(lp_file: Path, timeout: int) -> FeasibilityResult:
    try:
        gp, GRB = import_gurobi()
    except GurobiUnavailableError as exc:
        return FeasibilityResult(
            is_feasible=False,
            model_status=-1,
            solve_time=0.0,
            error_message=str(exc),
        )

    model = None
    try:
        model = gp.read(str(lp_file))
        model.setParam("OutputFlag", 0)
        model.setParam("TimeLimit", timeout)
        # Disable dual reductions so that INF_OR_UNBD (status 4) cannot
        # be returned. Per Gurobi's infeasibility docs, this forces the
        # solver to commit to either INFEASIBLE (3) or UNBOUNDED (5) —
        # which is exactly the distinction Step 3 needs.
        model.setParam("DualReductions", 0)

        start = time.perf_counter()
        model.optimize()
        elapsed = time.perf_counter() - start

        # Only OPTIMAL / SUBOPTIMAL proves feasibility. TIME_LIMIT, INTERRUPTED,
        # NUMERIC, etc. are inconclusive and must not be reported as feasible.
        is_feasible = model.status in (GRB.OPTIMAL, GRB.SUBOPTIMAL)
        status_msg = ""
        if not is_feasible and model.status not in (GRB.INFEASIBLE, GRB.UNBOUNDED):
            status_msg = (
                f"Solve ended with inconclusive status {model.status} "
                "(neither OPTIMAL nor INFEASIBLE/UNBOUNDED)."
            )
        return FeasibilityResult(
            is_feasible=is_feasible,
            model_status=model.status,
            solve_time=elapsed,
            error_message=status_msg,
        )

    except gp.GurobiError as exc:
        logger.exception("Gurobi error during feasibility test")
        return FeasibilityResult(
            is_feasible=False,
            model_status=-1,
            solve_time=0.0,
            error_message=f"Gurobi error: {exc}",
        )
    except (FileNotFoundError, OSError) as exc:
        logger.exception("I/O error during feasibility test")
        return FeasibilityResult(
            is_feasible=False,
            model_status=-1,
            solve_time=0.0,
            error_message=f"I/O error: {exc}",
        )
    finally:
        if model is not None:
            with contextlib.suppress(AttributeError, gp.GurobiError):
                model.dispose()
