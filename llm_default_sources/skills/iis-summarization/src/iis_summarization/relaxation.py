"""
relaxation.py
─────────────
Step 7 of the IIS analysis pipeline.

Quantifies how much each IIS constraint's right-hand side — and each
IIS-participating variable bound — needs to be relaxed to restore
feasibility, using Gurobi's ``feasRelax``.

  * IIS answers   "which constraints (and bounds) are in conflict?"
  * relaxation   answers "by exactly how much do I need to loosen them?"

Design choices
──────────────
* ``relaxobjtype=0`` — minimise the L1 sum of violations. Direct,
  interpretable, and the fastest of the three relaxation objectives
  (L2 is quadratic; L0 — count of violations — is itself a MIP and the
  slowest, per Gurobi's guidance).
* ``minrelax=True`` — the only mode that preserves MIP integrality
  (``minrelax=False`` linearises the model behind the scenes, which
  hides integer-infeasibility and makes feasRelax return zero
  violations on integer-infeasible MIPs). The phase-2 re-optimisation
  it implies is made trivially bounded by zeroing the original
  objective before the call.
* ``rhspen[i] = 1.0`` only for IIS constraints; ``GRB.INFINITY``
  (= must not be relaxed, per Gurobi's documented convention) for all
  others. A penalty of 0 would mean the OPPOSITE — violation free of
  charge — and silently shift the violation onto unreported elements.
* ``lbpen[i] = ubpen[i] = 1.0`` only for variables whose bounds are
  in the IIS (as captured in ``parsed.bounds``). When ``feasRelax``
  returns ``ArtL_<var>`` or ``ArtU_<var>``, that tells us the exact
  amount to loosen that variable's lower or upper bound.
* If the first pass returns UNBOUNDED or finds zero violations, we
  retry with every bound relaxable (``vrelax=True`` uniform) so that
  variables contributing to an unbounded ray become visible. The
  ``unbounded_detected`` flag is set accordingly.
"""

from __future__ import annotations

import contextlib
import logging
from pathlib import Path

from iis_summarization._gurobi import import_gurobi
from iis_summarization._utils import range_slack_map, sense_symbol
from iis_summarization.errors import GurobiUnavailableError
from iis_summarization.interfaces import IRelaxer
from iis_summarization.models import (
    ConstraintRelaxation,
    RelaxationResult,
    VariableBoundRelaxation,
)

logger = logging.getLogger(__name__)


class Relaxer(IRelaxer):
    """Default implementation of :class:`IRelaxer`."""

    @classmethod
    def create(cls) -> IRelaxer:
        """Factory returning an :class:`IRelaxer`."""
        return cls()

    def compute(
        self,
        lp_file: Path,
        constraint_names: list[str] | None,
        timeout: int,
        bound_variable_names: list[str] | None = None,
    ) -> RelaxationResult:
        return _compute_relaxations_impl(lp_file, constraint_names, timeout, bound_variable_names)


def compute_relaxations(
    lp_file: str | Path,
    constraint_names: list[str] | None = None,
    timeout: int = 60,
    bound_variable_names: list[str] | None = None,
) -> RelaxationResult:
    """Functional convenience wrapper around :class:`Relaxer`."""
    return Relaxer.create().compute(
        lp_file=Path(lp_file),
        constraint_names=list(constraint_names) if constraint_names else None,
        timeout=timeout,
        bound_variable_names=(list(bound_variable_names) if bound_variable_names else None),
    )


def _compute_relaxations_impl(
    lp_file: Path,
    constraint_names: list[str] | None,
    timeout: int,
    bound_variable_names: list[str] | None,
) -> RelaxationResult:
    """Run feasRelax with targeted penalties; retry broadly on UNBOUNDED."""
    result = RelaxationResult(success=False)

    try:
        gp, GRB = import_gurobi()
    except GurobiUnavailableError as exc:
        result.error_message = str(exc)
        return result

    try:
        first = _run_feas_relax(
            lp_file,
            constraint_names=constraint_names,
            bound_variable_names=bound_variable_names,
            relax_all_bounds=False,
            timeout=timeout,
            gp=gp,
            GRB=GRB,
        )

        first_returned_unbounded = first.unbounded_detected
        first_useful = (
            first.success
            and (first.constraint_relaxations or first.variable_bound_relaxations)
        )

        if first_useful and not first_returned_unbounded:
            _verify_fix(lp_file, first, timeout, gp, GRB)
            return first

        # When the targeted IIS relaxation produces no violations — or
        # is itself INFEASIBLE because non-target elements carry
        # GRB.INFINITY penalties and the real blocker lies outside the
        # IIS (another conflict, or a variable bound we didn't include)
        # — retry with EVERY constraint and EVERY bound relaxable so the
        # actual offenders become visible. (The L1 objective still only
        # penalises what actually needs to move, so only truly violated
        # items show up in the output.)
        logger.info(
            "Targeted feasRelax produced no useful violations — "
            "retrying with every constraint and every bound "
            "relaxable to surface the real blocker.",
        )
        retry = _run_feas_relax(
            lp_file,
            constraint_names=None,  # relax every constraint
            bound_variable_names=None,
            relax_all_bounds=True,  # relax every bound
            timeout=timeout,
            gp=gp,
            GRB=GRB,
        )
        # Only flag as unbounded if the first pass literally returned
        # UNBOUNDED; the zero-violations path often means the blocker
        # lies outside the IIS, not that the model is unbounded.
        if first_returned_unbounded:
            retry.unbounded_detected = True
        if retry.success and (retry.constraint_relaxations or retry.variable_bound_relaxations):
            _verify_fix(lp_file, retry, timeout, gp, GRB)
        return retry
    except (FileNotFoundError, OSError) as exc:
        logger.exception("I/O error during feasRelax")
        result.error_message = f"I/O error: {exc}"
        return result


def _run_feas_relax(
    lp_file: Path,
    constraint_names: list[str] | None,
    bound_variable_names: list[str] | None,
    relax_all_bounds: bool,
    timeout: int,
    gp: object,
    GRB: object,
) -> RelaxationResult:
    """Run a single feasRelax pass with explicit per-constraint / per-bound penalties."""
    result = RelaxationResult(success=False)

    model = None
    try:
        model = gp.read(str(lp_file))  # type: ignore[attr-defined]
        model.setParam("OutputFlag", 0)
        model.setParam("TimeLimit", timeout)

        constraints = model.getConstrs()
        variables = model.getVars()
        constraint_target = set(constraint_names) if constraint_names is not None else None
        bound_target: set[str] | None
        if relax_all_bounds:
            bound_target = None  # means "relax every bound"
        elif bound_variable_names is not None:
            bound_target = set(bound_variable_names)
        else:
            bound_target = set()  # means "relax no bound"

        # Gurobi convention: penalty GRB.INFINITY forbids relaxing an
        # element; 0 would make its violation FREE and silently absorb
        # the infeasibility into unreported elements.
        forbid = GRB.INFINITY  # type: ignore[attr-defined]
        rhspen = [
            1.0 if (constraint_target is None or c.ConstrName in constraint_target) else forbid
            for c in constraints
        ]
        if bound_target is None:
            lbpen = [1.0] * len(variables)
        else:
            lbpen = [1.0 if v.VarName in bound_target else forbid for v in variables]
        ubpen = list(lbpen)

        # Snapshot the original bounds BEFORE feasRelax: relaxable bounds
        # are replaced by artificial variables, so v.LB/v.UB afterwards
        # read ±infinity, not the user's data. The range-slack map must
        # also be built now, while the rows are unmodified.
        orig_bounds = {v.VarName: (v.LB, v.UB) for v in variables}
        slack_map = range_slack_map(model)

        # Zero out the original objective so that phase-2 of feasRelax
        # (which re-optimises over the original objective under
        # ``minrelax=True``) is trivially bounded. We keep
        # ``minrelax=True`` because it is the only mode that preserves
        # MIP integrality: ``minrelax=False`` linearises the model
        # behind the scenes, which hides integer-infeasibility and makes
        # feasRelax return zero violations on integer-infeasible MIPs.
        # Multi-objective models must additionally be reduced to a pure
        # feasibility problem (NumObj=0, Gurobi's documented pattern) —
        # feasRelax raises "Multi-objective problem and minrelax != 0"
        # otherwise.
        if getattr(model, "NumObj", 0) > 1:
            model.NumObj = 0
        for v in variables:
            v.Obj = 0.0
        model.update()

        model.feasRelax(
            relaxobjtype=0,
            minrelax=True,
            vars=variables,
            lbpen=lbpen,
            ubpen=ubpen,
            constrs=constraints,
            rhspen=rhspen,
        )
        model.optimize()

        if model.status == GRB.UNBOUNDED:  # type: ignore[attr-defined]
            result.error_message = "Relaxation solve returned UNBOUNDED."
            result.unbounded_detected = True
            return result

        if model.status not in (GRB.OPTIMAL, GRB.SUBOPTIMAL):  # type: ignore[attr-defined]
            result.error_message = f"Relaxation solve ended with status {model.status}."
            return result

        art_vars = {
            v.VarName: v.X
            for v in model.getVars()
            if v.VarName.startswith(("ArtP_", "ArtN_", "ArtL_", "ArtU_"))
        }

        for c in constraints:
            if constraint_target is not None and c.ConstrName not in constraint_target:
                continue
            pos = art_vars.get(f"ArtP_{c.ConstrName}", 0.0)
            neg = art_vars.get(f"ArtN_{c.ConstrName}", 0.0)
            violation = pos + neg
            if violation <= 1e-9:
                continue
            result.constraint_relaxations.append(
                ConstraintRelaxation(
                    constraint_name=c.ConstrName,
                    current_rhs=c.RHS,
                    sense=sense_symbol(c.Sense),
                    violation=violation,
                    direction=_direction_from_sense(c.Sense, pos, neg),
                )
            )

        for v in variables:
            if bound_target is not None and v.VarName not in bound_target:
                continue
            lb_v = art_vars.get(f"ArtL_{v.VarName}", 0.0)
            ub_v = art_vars.get(f"ArtU_{v.VarName}", 0.0)
            if lb_v > 1e-9 or ub_v > 1e-9:
                lb0, ub0 = orig_bounds.get(v.VarName, (v.LB, v.UB))
                result.variable_bound_relaxations.append(
                    VariableBoundRelaxation(
                        variable_name=v.VarName,
                        current_lb=lb0,
                        current_ub=ub0,
                        lb_violation=lb_v,
                        ub_violation=ub_v,
                        range_of=slack_map.get(v.VarName, ""),
                    )
                )

        result.total_violation = sum(r.violation for r in result.constraint_relaxations) + sum(
            br.lb_violation + br.ub_violation for br in result.variable_bound_relaxations
        )
        result.success = True
        return result

    except gp.GurobiError as exc:  # type: ignore[attr-defined]
        logger.exception("Gurobi error during feasRelax")
        result.error_message = f"Gurobi error: {exc}"
        return result
    finally:
        if model is not None:
            with contextlib.suppress(AttributeError, gp.GurobiError):  # type: ignore[attr-defined]
                model.dispose()


def _verify_fix(
    lp_file: Path,
    result: RelaxationResult,
    timeout: int,
    gp: object,
    GRB: object,
    margin: float = 1e-6,
) -> None:
    """Apply the suggested RHS/bound changes to a fresh model copy,
    re-optimize, and record whether the model actually became feasible.

    Sets ``result.fix_verified`` / ``result.fix_verification_message``.
    Inequalities get a tiny extra *margin* so the verified model is not
    knife-edge feasible; equalities are shifted by the exact violation
    (a margin would push an equality back into infeasibility). The copy
    keeps integrality, so for MIPs this certifies the INTEGER model.
    """
    model = None
    try:
        model = gp.read(str(lp_file))  # type: ignore[attr-defined]
        model.setParam("OutputFlag", 0)
        model.setParam("TimeLimit", timeout)

        for cr in result.constraint_relaxations:
            c = model.getConstrByName(cr.constraint_name)
            if c is None:
                result.fix_verified = False
                result.fix_verification_message = (
                    f"Constraint {cr.constraint_name!r} not found in model."
                )
                return
            if c.Sense == "<":
                c.RHS = c.RHS + cr.violation + margin
            elif c.Sense == ">":
                c.RHS = c.RHS - cr.violation - margin
            elif cr.direction.startswith("increase"):
                c.RHS = c.RHS + cr.violation
            else:
                c.RHS = c.RHS - cr.violation

        for br in result.variable_bound_relaxations:
            v = model.getVarByName(br.variable_name)
            if v is None:
                result.fix_verified = False
                result.fix_verification_message = (
                    f"Variable {br.variable_name!r} not found in model."
                )
                return
            if br.lb_violation > 0:
                v.LB = v.LB - br.lb_violation - margin
            if br.ub_violation > 0:
                v.UB = v.UB + br.ub_violation + margin

        model.update()
        model.optimize()

        if model.status in (GRB.OPTIMAL, GRB.SUBOPTIMAL):  # type: ignore[attr-defined]
            result.fix_verified = True
            result.fix_verification_message = (
                "Applying the suggested changes to a copy of the model "
                "restored feasibility (verified by re-solving)."
            )
        else:
            result.fix_verified = False
            result.fix_verification_message = (
                f"Re-solve after applying the suggested changes ended with "
                f"status {model.status} — the changes alone do not restore "
                "feasibility (another conflict may remain)."
            )
    except gp.GurobiError as exc:  # type: ignore[attr-defined]
        result.fix_verified = False
        result.fix_verification_message = f"Verification solve failed: {exc}"
    finally:
        if model is not None:
            with contextlib.suppress(AttributeError, gp.GurobiError):  # type: ignore[attr-defined]
                model.dispose()


def _direction_from_sense(sense_char: str, pos: float, neg: float) -> str:
    """Translate sense + artificial variables into a human-readable direction.

    Gurobi's documented convention (feasRelax artificial variables):
    ``ArtP_c > 0`` means slack had to be ADDED to the LHS — the LHS
    cannot reach the RHS from below, so the fix is to DECREASE the RHS.
    ``ArtN_c > 0`` means slack had to be REMOVED from the LHS — the LHS
    overshoots the RHS, so the fix is to INCREASE the RHS. This holds
    for every sense; for inequalities only one of the two can be active.
    """
    if sense_char == "<":
        return "increase RHS (or reduce LHS contribution)"
    if sense_char == ">":
        return "decrease RHS (or increase LHS contribution)"
    # Equality: ArtP (pos) → decrease RHS; ArtN (neg) → increase RHS.
    if pos > neg:
        return "decrease RHS"
    return "increase RHS"
