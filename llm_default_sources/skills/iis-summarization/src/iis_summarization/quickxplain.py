"""
quickxplain.py
──────────────
Phase 4 of the large-model fast filter pipeline.

Implements Junker's QuickXplain algorithm (AAAI 2004) — a divide-and-
conquer approach to finding a minimal infeasible subset of a constraint
set.

Algorithm
─────────
    find_iis(C, background=∅):
        if is_infeasible(background) already: return []   # background alone is infeasible
        if is_infeasible(background ∪ C) is False: return []  # no conflict in C given background
        if |C| == 1: return C                              # base case: single essential constraint
        split C into C1 (first half), C2 (second half)
        D2 = find_iis(C2, background=background ∪ C1)    # find conflict using C2 with C1 as context
        D1 = find_iis(C1, background=background ∪ D2)    # find conflict using C1 with D2 as context
        return D1 ∪ D2

Complexity: O(k · log(n/k)) feasibility tests where k = |IIS|,
n = |candidates|.  For k=5, n=50: ~30 tests.  For k=10, n=50: ~50
tests.  Compare to Chinneck's O(n) = 50 tests — similar for small k,
vastly better when n is large.

Reference
─────────
    Junker, U. (2004). QUICKXPLAIN: Preferred explanations and
    relaxations for over-constrained problems. Proc. AAAI-2004.
"""

from __future__ import annotations

import contextlib
import logging
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


class QuickXplain:
    """Divide-and-conquer IIS isolation (Junker 2004)."""

    @staticmethod
    def find_iis(
        lp_file: Path,
        candidates: list[str],
        timeout: int,
        gp: Any,
        GRB: Any,
    ) -> list[str]:
        """Return the minimal IIS subset of *candidates*.

        Parameters
        ----------
        lp_file:
            The original infeasible LP/MIP file.  The full model is
            loaded once as a base; sub-problems are built via
            ``base_model.copy()`` with non-candidate constraints removed.
        candidates:
            Constraint names to search within.  Must be a subset of the
            model's constraints.  The true IIS must be contained in this
            set for a correct answer.
        timeout:
            Per-sub-problem Gurobi ``TimeLimit`` in seconds.
        gp:
            The ``gurobipy`` module object.
        GRB:
            The ``gurobipy.GRB`` constants object.

        Returns
        -------
        list[str]
            Minimal infeasible subset of *candidates*.  Empty list if
            *candidates* is feasible on its own (no conflict found).
        """
        if not candidates:
            return []

        base_model = None
        try:
            base_model = gp.read(str(lp_file))
            base_model.setParam("OutputFlag", 0)
            base_model.setParam("TimeLimit", timeout)
            base_model.update()

            solve_count = [0]

            def is_infeasible(constraint_set: list[str]) -> bool:
                """Test whether *constraint_set* constraints are infeasible."""
                solve_count[0] += 1
                keep = set(constraint_set)
                trial = base_model.copy()
                trial.setParam("TimeLimit", timeout)
                try:
                    for c in list(trial.getConstrs()):
                        if c.ConstrName not in keep:
                            trial.remove(c)
                    trial.update()
                    trial.optimize()
                    return trial.status == GRB.INFEASIBLE
                finally:
                    with contextlib.suppress(Exception):
                        trial.dispose()

            # Pre-check: if candidates are feasible, there is no IIS to find.
            # We pass skip_initial_check=True so _qx_recurse doesn't repeat
            # this same test at the root recursion level.
            if not is_infeasible(list(candidates)):
                logger.info("QuickXplain: candidates are feasible — returning empty.")
                return []

            result = _qx_recurse(
                candidates, background=[], is_infeasible=is_infeasible,
                skip_initial_check=True,
            )
            logger.info(
                "QuickXplain: found IIS of size %d in %d feasibility tests "
                "(|candidates|=%d).",
                len(result),
                solve_count[0],
                len(candidates),
            )
            return result

        except gp.GurobiError as exc:
            logger.exception("Gurobi error in QuickXplain: %s", exc)
            return []
        finally:
            if base_model is not None:
                with contextlib.suppress(Exception):
                    base_model.dispose()


def _qx_recurse(
    C: list[str],
    background: list[str],
    is_infeasible: Any,
    skip_initial_check: bool = False,
) -> list[str]:
    """Recursive QuickXplain step.

    Parameters
    ----------
    C:
        Current candidate set to search within.
    background:
        Constraints that are always present (already committed to the
        IIS).
    is_infeasible:
        Callable(list[str]) -> bool. Tests feasibility of the given
        constraint set.
    skip_initial_check:
        When True, skip the ``is_infeasible(background + C)`` test at
        this level — the caller already confirmed infeasibility.  Only
        used at the root level to avoid a redundant test.
    """
    # If background alone is already infeasible, C adds nothing.
    if background and is_infeasible(background):
        return []

    # If the full set is feasible, no conflict exists within C.
    if not skip_initial_check and not is_infeasible(background + C):
        return []

    # Base case: single constraint that is essential.
    if len(C) == 1:
        return list(C)

    # Divide C into two halves.
    mid = len(C) // 2
    C1 = C[:mid]
    C2 = C[mid:]

    # Find conflict in C2 using C1 as additional background.
    D2 = _qx_recurse(C2, background=background + C1, is_infeasible=is_infeasible)
    # Find conflict in C1 using D2 as additional background.
    D1 = _qx_recurse(C1, background=background + D2, is_infeasible=is_infeasible)

    return D1 + D2
