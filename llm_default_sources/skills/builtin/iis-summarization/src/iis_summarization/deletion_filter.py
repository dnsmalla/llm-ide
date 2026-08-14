"""
deletion_filter.py
──────────────────
Step 4 of the IIS analysis pipeline — Chinneck's deletion filter.

Algorithm
─────────
    given IIS = {c1, ..., cn}:
        for each ci in IIS:
            build a trial model containing only the constraints IIS \\ {ci}
            solve
            if still INFEASIBLE:
                ci was redundant → drop it
            else:
                ci is essential → keep

Gurobi's ``computeIIS`` already returns an irreducible subsystem, so in
practice this filter usually drops zero constraints — it serves as a
sanity check and handles edge cases such as user-supplied .ilp files
that may have been manually edited.

Reference
─────────
    Chinneck, J. W. (1991). "Localizing and diagnosing infeasibilities
    in linear programming models." Computers & Operations Research.
"""

from __future__ import annotations

import logging
import time
from pathlib import Path

from iis_summarization._gurobi import import_gurobi
from iis_summarization.errors import GurobiUnavailableError
from iis_summarization.interfaces import IDeletionFilter
from iis_summarization.models import DeletionFilterResult

logger = logging.getLogger(__name__)


class DeletionFilter(IDeletionFilter):
    """Default implementation of :class:`IDeletionFilter`."""

    @classmethod
    def create(cls) -> IDeletionFilter:
        """Factory returning an :class:`IDeletionFilter`."""
        return cls()

    def minimize(
        self,
        lp_file: Path,
        iis_constraint_names: list[str],
        feasibility_timeout: int,
        target_size: int | None = None,
        budget_seconds: float | None = None,
    ) -> DeletionFilterResult:
        return _minimize_iis_impl(
            lp_file=lp_file,
            iis_constraint_names=iis_constraint_names,
            feasibility_timeout=feasibility_timeout,
            target_size=target_size,
            budget_seconds=budget_seconds,
        )


def minimize_iis(
    lp_file: str | Path,
    iis_constraint_names: list[str],
    feasibility_timeout: int = 30,
    target_size: int | None = None,
    budget_seconds: float | None = None,
) -> DeletionFilterResult:
    """Functional convenience wrapper around :class:`DeletionFilter`."""
    return DeletionFilter.create().minimize(
        lp_file=Path(lp_file),
        iis_constraint_names=list(iis_constraint_names),
        feasibility_timeout=feasibility_timeout,
        target_size=target_size,
        budget_seconds=budget_seconds,
    )


def _minimize_iis_impl(
    lp_file: Path,
    iis_constraint_names: list[str],
    feasibility_timeout: int,
    target_size: int | None,
    budget_seconds: float | None,
) -> DeletionFilterResult:
    """Drop IIS constraints one at a time; stop early on target or budget.

    ``target_size`` — if set, stop as soon as the surviving IIS has this
    many or fewer constraints. Note: Gurobi's IIS is already minimal, so
    reaching a target below the true minimum is impossible and the loop
    will simply exhaust the input list without further drops.

    ``budget_seconds`` — if set, stop the loop as soon as this wall-clock
    elapses. The partial result is still returned (with ``success=True``
    if at least one iteration ran). This prevents Chinneck from running
    for hours on a 200k-row IIS.
    """
    result = DeletionFilterResult(success=False)

    if not iis_constraint_names:
        result.error_message = "No IIS constraints provided."
        return result

    try:
        gp, GRB = import_gurobi()
    except GurobiUnavailableError as exc:
        result.error_message = str(exc)
        return result

    start = time.perf_counter()
    iis_set = set(iis_constraint_names)
    surviving = list(iis_constraint_names)
    dropped: list[str] = []
    iterations = 0
    stopped_early = False

    try:
        for name in list(iis_constraint_names):
            # Target-size early exit.
            if target_size is not None and len(surviving) <= target_size:
                logger.info(
                    "Deletion filter: target size %d reached (|IIS|=%d); stopping.",
                    target_size,
                    len(surviving),
                )
                stopped_early = True
                break

            # Wall-clock budget exit.
            if budget_seconds is not None and (time.perf_counter() - start) >= budget_seconds:
                logger.warning(
                    "Deletion filter: %ss budget exhausted at iter %d; "
                    "|IIS|=%d (target=%s). Returning partial result.",
                    budget_seconds,
                    iterations,
                    len(surviving),
                    target_size,
                )
                stopped_early = True
                break

            iterations += 1

            # Keep only IIS-minus-dropped-minus-{name}; everything else is
            # removed before solving (variables and bounds are retained).
            keep_set = iis_set - set(dropped) - {name}

            trial_model = gp.read(str(lp_file))
            trial_model.setParam("OutputFlag", 0)
            trial_model.setParam("TimeLimit", feasibility_timeout)

            try:
                for constr in list(trial_model.getConstrs()):
                    if constr.ConstrName not in keep_set:
                        trial_model.remove(constr)

                trial_model.optimize()

                if trial_model.status == GRB.INFEASIBLE:
                    dropped.append(name)
                    surviving.remove(name)
                    logger.debug("'%s' is redundant in the IIS", name)
                else:
                    logger.debug(
                        "'%s' is essential (trial status=%d)",
                        name,
                        trial_model.status,
                    )
            finally:
                trial_model.dispose()

        result.minimal_iis = surviving
        result.dropped_as_redundant = dropped
        result.iterations = iterations
        result.elapsed_seconds = time.perf_counter() - start
        result.success = True
        if stopped_early and target_size is not None and len(surviving) > target_size:
            result.error_message = (
                f"Budget {budget_seconds}s exhausted before reaching target "
                f"{target_size}; |IIS|={len(surviving)}."
            )
        return result

    except gp.GurobiError as exc:
        logger.exception("Gurobi error during deletion filter")
        result.error_message = f"Gurobi error: {exc}"
        result.elapsed_seconds = time.perf_counter() - start
        return result
    except (FileNotFoundError, OSError) as exc:
        logger.exception("I/O error during deletion filter")
        result.error_message = f"I/O error: {exc}"
        result.elapsed_seconds = time.perf_counter() - start
        return result
