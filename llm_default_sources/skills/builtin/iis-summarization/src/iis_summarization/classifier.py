"""
classifier.py
─────────────
Step 5 of the IIS analysis pipeline.

Classifies each IIS constraint as a DATA or STRUCTURE problem.

Definitions
───────────
    DATA problem
        The RHS is unreachable given variable bounds alone — i.e. the
        constraint is infeasible in isolation, independent of other
        constraints. Fix: adjust input data.

    STRUCTURE problem
        The constraint is satisfiable by some assignment of its own
        variables within their bounds, but combined with another IIS
        constraint no joint assignment exists. Fix: relax a logical
        coupling, add slack, or rethink the model structure.
"""

from __future__ import annotations

import contextlib
import logging
import math
from pathlib import Path
from typing import Any

from iis_summarization._gurobi import import_gurobi
from iis_summarization._utils import sense_symbol
from iis_summarization.errors import GurobiUnavailableError
from iis_summarization.interfaces import IClassifier
from iis_summarization.models import (
    ClassificationResult,
    ConstraintClassification,
    ProblemType,
)

logger = logging.getLogger(__name__)

_EPS = 1e-9


class Classifier(IClassifier):
    """Default implementation of :class:`IClassifier`."""

    @classmethod
    def create(cls) -> IClassifier:
        """Factory returning an :class:`IClassifier`."""
        return cls()

    def classify(
        self,
        lp_file: Path,
        iis_constraint_names: list[str],
        model: Any | None = None,
    ) -> ClassificationResult:
        return _classify_iis_impl(lp_file, iis_constraint_names, model)


def classify_iis_constraints(
    lp_file: str | Path,
    iis_constraint_names: list[str],
    model: Any | None = None,
) -> ClassificationResult:
    """Functional convenience wrapper around :class:`Classifier`."""
    return Classifier.create().classify(
        lp_file=Path(lp_file),
        iis_constraint_names=list(iis_constraint_names),
        model=model,
    )


def _classify_iis_impl(
    lp_file: Path,
    iis_constraint_names: list[str],
    shared_model: Any | None = None,
) -> ClassificationResult:
    result = ClassificationResult(success=False)

    try:
        gp, _ = import_gurobi()
    except GurobiUnavailableError as exc:
        result.error_message = str(exc)
        return result

    # A model passed in by the orchestrator is borrowed, not owned —
    # never dispose it here.
    owns_model = shared_model is None
    model = None
    try:
        if shared_model is not None:
            model = shared_model
        else:
            model = gp.read(str(lp_file))
            model.setParam("OutputFlag", 0)
        model.update()

        var_bounds: dict[str, tuple[float, float]] = {
            v.VarName: (v.LB, v.UB) for v in model.getVars()
        }

        target = set(iis_constraint_names)

        for c in model.getConstrs():
            if c.ConstrName not in target:
                continue

            sense = sense_symbol(c.Sense)
            rhs = c.RHS
            row = model.getRow(c)
            lhs_min, lhs_max = _lhs_range(row, var_bounds)

            problem_type, reason = _decide(
                sense=sense,
                rhs=rhs,
                lhs_min=lhs_min,
                lhs_max=lhs_max,
            )

            result.classifications.append(
                ConstraintClassification(
                    constraint_name=c.ConstrName,
                    problem_type=problem_type,
                    reason=reason,
                    lhs_bounds=(lhs_min, lhs_max),
                    rhs_value=rhs,
                    sense=sense,
                )
            )

        result.success = True
        return result

    except gp.GurobiError as exc:
        logger.exception("Gurobi error during classification")
        result.error_message = f"Gurobi error: {exc}"
        return result
    except (FileNotFoundError, OSError) as exc:
        logger.exception("I/O error during classification")
        result.error_message = f"I/O error: {exc}"
        return result
    finally:
        if owns_model and model is not None:
            with contextlib.suppress(AttributeError, gp.GurobiError):
                model.dispose()


def _lhs_range(
    row: Any,
    var_bounds: dict[str, tuple[float, float]],
) -> tuple[float, float]:
    """
    Compute the minimum and maximum possible LHS value using variable
    bounds alone. Returns ``(lhs_min, lhs_max)``.
    """
    lhs_min = 0.0
    lhs_max = 0.0
    for i in range(row.size()):
        var = row.getVar(i)
        coef = row.getCoeff(i)
        lb, ub = var_bounds.get(var.VarName, (-math.inf, math.inf))

        if coef >= 0:
            lhs_min += coef * lb
            lhs_max += coef * ub
        else:
            lhs_min += coef * ub
            lhs_max += coef * lb
    return lhs_min, lhs_max


def _decide(
    sense: str,
    rhs: float,
    lhs_min: float,
    lhs_max: float,
) -> tuple[ProblemType, str]:
    """Return ``(problem_type, reason)`` for a single constraint."""
    if sense == "<=":
        if lhs_min > rhs + _EPS:
            return (
                "data",
                f"LHS minimum ({lhs_min:.4g}) exceeds RHS ({rhs:.4g}) using "
                "variable bounds alone — the constraint cannot be satisfied "
                "by any assignment in its variable domain.",
            )
        return (
            "structure",
            f"LHS is reachable <= RHS in isolation (range [{lhs_min:.4g}, "
            f"{lhs_max:.4g}]) — the conflict arises from interaction with "
            "another constraint.",
        )

    if sense == ">=":
        if lhs_max < rhs - _EPS:
            return (
                "data",
                f"LHS maximum ({lhs_max:.4g}) falls short of RHS ({rhs:.4g}) "
                "using variable bounds alone — the constraint is unreachable "
                "in its variable domain.",
            )
        return (
            "structure",
            f"LHS is reachable >= RHS in isolation (range [{lhs_min:.4g}, "
            f"{lhs_max:.4g}]) — the conflict arises from interaction with "
            "another constraint.",
        )

    if sense == "=":
        if not (lhs_min - _EPS <= rhs <= lhs_max + _EPS):
            return (
                "data",
                f"RHS ({rhs:.4g}) falls outside the feasible LHS range "
                f"[{lhs_min:.4g}, {lhs_max:.4g}] — the equality cannot be "
                "satisfied by any assignment.",
            )
        return (
            "structure",
            f"RHS is within the LHS range [{lhs_min:.4g}, {lhs_max:.4g}] "
            "in isolation — the conflict arises from interaction with "
            "another constraint.",
        )

    return "unknown", f"Unrecognized sense: {sense}"
