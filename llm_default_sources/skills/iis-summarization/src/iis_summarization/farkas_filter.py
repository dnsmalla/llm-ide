"""
farkas_filter.py
────────────────
Phase 2 of the large-model fast filter pipeline.

Extracts constraints with non-zero Farkas dual multipliers from an
already-solved infeasible model.  Constraints with zero Farkas dual
are provably outside any IIS and can be dropped from the candidate
set before the more expensive elastic filter (Phase 3) runs.

Background
──────────
When an LP is infeasible, the dual simplex produces a Farkas dual
ray y such that y'b > 0 and y'A ≤ 0.  Gurobi exposes this as the
``FarkasDual`` attribute on each constraint after an infeasible
``optimize()`` call.  Any constraint with y_i = 0 is irrelevant to
this particular infeasibility proof.

In practice this eliminates 60–80 % of constraints on well-structured
models before any additional solver call is needed.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


def extract_farkas_candidates(
    model: Any,
    iis_names: list[str],
    tolerance: float = 1e-8,
) -> list[str]:
    """Return the subset of *iis_names* with non-zero Farkas dual multiplier.

    Parameters
    ----------
    model:
        A gurobipy ``Model`` that has already been solved and returned
        ``INFEASIBLE``.  The ``FarkasDual`` attribute is read from each
        constraint.
    iis_names:
        The IIS constraint names to filter (a subset of the model's
        constraints).
    tolerance:
        Constraints with ``|FarkasDual| <= tolerance`` are considered
        zero and dropped.  Default: 1e-8.

    Returns
    -------
    list[str]
        Filtered list of constraint names. If ``FarkasDual`` is
        unavailable (old Gurobi version, or model was not LP-solved),
        returns *iis_names* unchanged so the pipeline can continue.
    """
    iis_set = set(iis_names)
    dual_map: dict[str, float] = {}

    try:
        for c in model.getConstrs():
            if c.ConstrName not in iis_set:
                continue
            try:
                dual_map[c.ConstrName] = c.FarkasDual
            except AttributeError:
                # FarkasDual not available on this constraint/version.
                logger.debug(
                    "FarkasDual not available on constraint '%s'; "
                    "skipping Farkas filter.",
                    c.ConstrName,
                )
                return list(iis_names)
    except Exception as exc:
        logger.warning(
            "Farkas filter failed (%s); returning all %d candidates.",
            exc,
            len(iis_names),
        )
        return list(iis_names)

    kept = [n for n in iis_names if abs(dual_map.get(n, 0.0)) > tolerance]

    if not kept:
        # All duals were zero — something is wrong (e.g. MIP, or model
        # was solved with barrier method which doesn't produce a dual ray).
        # Fall back to the full candidate set.
        logger.info(
            "Farkas filter: all %d duals were zero — falling back to "
            "full candidate set (this is normal for MIP models).",
            len(iis_names),
        )
        return list(iis_names)

    reduction = 100.0 * (1 - len(kept) / len(iis_names)) if iis_names else 0.0
    logger.info(
        "Farkas filter: kept %d/%d constraints (%.0f%% reduction).",
        len(kept),
        len(iis_names),
        reduction,
    )
    return kept
