"""
indicator_relaxation.py
───────────────────────
Minimum-data-change computation for INDICATOR (general) constraints.

feasRelax is hard-limited to linear constraints and variable bounds —
it never relaxes quadratic / SOS / general constraints and reports zero
violations for them (documented Gurobi behavior). Gurobi's recommended
automated alternative for indicator conflicts is explicit slack
injection:

    b = 1  ->  x >= 10        becomes        b = 1  ->  x + s >= 10
    (s >= 0, objective: minimize s)

The optimal ``s`` is the exact minimum RHS delta for the indicator's
linear part — directly analogous to what feasRelax computes for linear
constraints. Big-M reformulation is deliberately NOT used (large M
causes ill-conditioning and M-dependent, unreliable answers — per
Gurobi's guidance).

Only indicator-type general constraints are instrumented; other general
constraint types (min/max/abs/...) are skipped gracefully.
"""

from __future__ import annotations

import contextlib
import logging
from pathlib import Path

from iis_summarization._gurobi import import_gurobi
from iis_summarization.errors import GurobiUnavailableError
from iis_summarization.models import ConstraintRelaxation, RelaxationResult

logger = logging.getLogger(__name__)

_EPS = 1e-9


def compute_indicator_relaxations(
    lp_file: str | Path,
    gen_constr_names: list[str],
    timeout: int = 60,
) -> RelaxationResult:
    """Compute the minimum RHS delta per indicator constraint in
    *gen_constr_names* via slack injection, and verify the fix.

    Returns a :class:`RelaxationResult` whose ``constraint_relaxations``
    entries carry the indicator's name, current linear-part RHS, sense,
    minimum violation, and direction. ``fix_verified`` is True when
    applying the suggested RHS changes to a fresh copy restored
    feasibility.
    """
    lp_path = Path(lp_file)
    result = RelaxationResult(success=False)

    try:
        gp, GRB = import_gurobi()
    except GurobiUnavailableError as exc:
        result.error_message = str(exc)
        return result

    model = None
    try:
        model = gp.read(str(lp_path))
        model.setParam("OutputFlag", 0)
        model.setParam("TimeLimit", timeout)

        target = set(gen_constr_names)
        # (name, sense, rhs, slack_vars) per instrumented indicator.
        instrumented: list[tuple[str, str, float, list]] = []

        for gc in list(model.getGenConstrs()):
            name = gc.GenConstrName
            if name not in target:
                continue
            if gc.GenConstrType != GRB.GENCONSTR_INDICATOR:
                logger.info(
                    "Skipping general constraint %r: not an indicator "
                    "(type %d) — slack injection only applies to indicators.",
                    name,
                    gc.GenConstrType,
                )
                continue

            binvar, binval, expr, sense, rhs = model.getGenConstrIndicator(gc)
            model.remove(gc)

            slacks: list = []
            if sense == GRB.LESS_EQUAL:
                s = model.addVar(lb=0.0, obj=1.0, name=f"IndSlackN_{name}")
                slacks.append(("N", s))
                new_expr = expr - s
            elif sense == GRB.GREATER_EQUAL:
                s = model.addVar(lb=0.0, obj=1.0, name=f"IndSlackP_{name}")
                slacks.append(("P", s))
                new_expr = expr + s
            else:  # equality — slack in both directions
                sp = model.addVar(lb=0.0, obj=1.0, name=f"IndSlackP_{name}")
                sn = model.addVar(lb=0.0, obj=1.0, name=f"IndSlackN_{name}")
                slacks.append(("P", sp))
                slacks.append(("N", sn))
                new_expr = expr + sp - sn

            model.addGenConstrIndicator(
                binvar, binval, new_expr, sense, rhs, name=f"{name}__slacked"
            )
            instrumented.append((name, sense, rhs, slacks))

        if not instrumented:
            result.success = True
            return result

        # Minimize total slack only. Multi-objective models are reduced
        # to a single objective first so the slack minimization is not
        # overridden by the original objective hierarchy.
        if getattr(model, "NumObj", 0) > 1:
            model.NumObj = 0
            slack_vars = [
                v for v in model.getVars() if v.VarName.startswith("IndSlack")
            ]
            model.setObjective(gp.quicksum(slack_vars), GRB.MINIMIZE)
        else:
            for v in model.getVars():
                if not v.VarName.startswith("IndSlack"):
                    v.Obj = 0.0
        model.update()
        model.optimize()

        if model.status not in (GRB.OPTIMAL, GRB.SUBOPTIMAL):
            result.error_message = (
                f"Slack-injection solve ended with status {model.status} — "
                "the conflict involves more than the targeted indicator(s)."
            )
            return result

        for name, sense, rhs, slacks in instrumented:
            total = sum(s.X for _, s in slacks)
            if total <= _EPS:
                continue
            pos = sum(s.X for kind, s in slacks if kind == "P")
            neg = sum(s.X for kind, s in slacks if kind == "N")
            # Same documented convention as feasRelax: positive slack on
            # the LHS (ArtP analog) → decrease RHS; negative → increase.
            direction = "decrease RHS" if pos > neg else "increase RHS"
            result.constraint_relaxations.append(
                ConstraintRelaxation(
                    constraint_name=name,
                    current_rhs=rhs,
                    sense={
                        GRB.LESS_EQUAL: "<=",
                        GRB.GREATER_EQUAL: ">=",
                    }.get(sense, "="),
                    violation=total,
                    direction=direction,
                )
            )

        result.total_violation = sum(
            r.violation for r in result.constraint_relaxations
        )
        result.success = True

        if result.constraint_relaxations:
            _verify_indicator_fix(lp_path, result, timeout, gp, GRB)
        return result

    except gp.GurobiError as exc:
        logger.exception("Gurobi error during indicator slack injection")
        result.error_message = f"Gurobi error: {exc}"
        return result
    finally:
        if model is not None:
            with contextlib.suppress(AttributeError, gp.GurobiError):
                model.dispose()


def _verify_indicator_fix(
    lp_path: Path,
    result: RelaxationResult,
    timeout: int,
    gp: object,
    GRB: object,
) -> None:
    """Apply the suggested indicator RHS changes to a fresh copy,
    re-optimize, and record whether the model became feasible."""
    by_name = {r.constraint_name: r for r in result.constraint_relaxations}
    model = None
    try:
        model = gp.read(str(lp_path))  # type: ignore[attr-defined]
        model.setParam("OutputFlag", 0)
        model.setParam("TimeLimit", timeout)

        for gc in list(model.getGenConstrs()):
            r = by_name.get(gc.GenConstrName)
            if r is None or gc.GenConstrType != GRB.GENCONSTR_INDICATOR:  # type: ignore[attr-defined]
                continue
            binvar, binval, expr, sense, rhs = model.getGenConstrIndicator(gc)
            new_rhs = (
                rhs - r.violation
                if r.direction.startswith("decrease")
                else rhs + r.violation
            )
            model.remove(gc)
            model.addGenConstrIndicator(
                binvar, binval, expr, sense, new_rhs, name=gc.GenConstrName
            )
        model.update()
        model.optimize()

        if model.status in (GRB.OPTIMAL, GRB.SUBOPTIMAL):  # type: ignore[attr-defined]
            result.fix_verified = True
            result.fix_verification_message = (
                "Applying the suggested indicator RHS changes to a copy of "
                "the model restored feasibility (verified by re-solving)."
            )
        else:
            result.fix_verified = False
            result.fix_verification_message = (
                f"Re-solve after the indicator RHS changes ended with status "
                f"{model.status} — another conflict remains."
            )
    except gp.GurobiError as exc:  # type: ignore[attr-defined]
        result.fix_verified = False
        result.fix_verification_message = f"Verification solve failed: {exc}"
    finally:
        if model is not None:
            with contextlib.suppress(AttributeError, gp.GurobiError):  # type: ignore[attr-defined]
                model.dispose()
