"""
propagation.py
──────────────
Step 5.5 of the IIS analysis pipeline.

Feasibility-based bound tightening (FBBT) over the IIS constraints. The
goal is to turn a small all-STRUCTURE IIS — where the classifier can
only say "the conflict arises from interaction with another
constraint" — into a concrete, numeric *forcing chain*: the ordered
sequence of forced variable implications that culminates in the exact
contradiction.

The engine repeatedly tightens each variable's interval from every IIS
constraint until a fixed point or an empty domain:

    pump_min_p_limit:  v_p_hp >= 100
    pump_fclmax:       v_p_hp - 100·f_utl_hp <= 0   ⟹ f_utl_hp = 1
    pump_gen_simul:    f_utl_hg + f_utl_hp <= 1     ⟹ f_utl_hg = 0
    effective_height:  v_effh - 121·f_utl_hg <= 0   ⟹ v_effh <= 0
    calc_max_p_wq_hs:  -0.9128·v_effh + v_max = -0.7637  ⟹ v_max <= -0.7637
                       v_max default LB = 0  ← CONTRADICTION

FBBT is *sound but incomplete*: every contradiction it reports is real,
but a purely combinatorial conflict with no propagating bound leaves
``reached_contradiction=False`` and the report falls back to the
constraint list. The arithmetic core (:func:`propagate_rows`) touches
no solver and is unit-testable with hand-built :class:`Row`/:class:`Domain`.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from iis_summarization._gurobi import import_gurobi
from iis_summarization._utils import sense_symbol
from iis_summarization.errors import GurobiUnavailableError
from iis_summarization.i18n import DEFAULT_LANGUAGE, tr
from iis_summarization.interfaces import IPropagator
from iis_summarization.models import Contradiction, PropagationTrace, TraceStep

logger = logging.getLogger(__name__)

# Emptiness / equality tolerance — matches the classifier's epsilon.
_EPS = 1e-9
# A tightening must beat the current bound by more than this to count as
# progress; prevents float churn from looping forever on a real bound.
_IMPROVE = 1e-7
# Runaway guard: stop after this many recorded tightenings regardless.
_MAX_TIGHTENINGS = 1000


@dataclass
class Domain:
    """Mutable interval for one variable during propagation."""

    lb: float
    ub: float
    is_integer: bool = False
    default_lb_zero: bool = False
    """True for a continuous variable whose lower bound is Gurobi's
    default 0 — flagged so the contradiction can call it out."""


@dataclass
class Row:
    """One linear IIS constraint: ``sum(coef·var) sense rhs``."""

    name: str
    terms: dict[str, float]
    sense: str  # "<=", ">=", "="
    rhs: float


class Propagator(IPropagator):
    """Default implementation of :class:`IPropagator`."""

    @classmethod
    def create(cls) -> IPropagator:
        """Factory returning an :class:`IPropagator`."""
        return cls()

    def trace(
        self,
        lp_file: Path,
        iis_constraint_names: list[str],
        model: Any | None = None,
        language: str = DEFAULT_LANGUAGE,
    ) -> PropagationTrace:
        return _trace_impl(lp_file, iis_constraint_names, model, language)


def trace_iis(
    lp_file: str | Path,
    iis_constraint_names: list[str],
    language: str = DEFAULT_LANGUAGE,
) -> PropagationTrace:
    """Functional convenience wrapper around :class:`Propagator`."""
    return Propagator.create().trace(
        lp_file=Path(lp_file),
        iis_constraint_names=list(iis_constraint_names),
        language=language,
    )


# ─────────────────────────────────────────────────────────────
# Gurobi extraction (thin shim)
# ─────────────────────────────────────────────────────────────


def _trace_impl(
    lp_file: Path,
    iis_constraint_names: list[str],
    shared_model: Any | None,
    language: str = DEFAULT_LANGUAGE,
) -> PropagationTrace:
    try:
        gp, _ = import_gurobi()
    except GurobiUnavailableError as exc:
        return PropagationTrace(success=False, error_message=str(exc))

    owns_model = shared_model is None
    model: Any = None
    try:
        model = gp.read(str(lp_file)) if owns_model else shared_model
        model.setParam("OutputFlag", 0)
        model.update()
        rows, domains = _build_problem(model, iis_constraint_names)
    except gp.GurobiError as exc:
        logger.exception("Gurobi error during propagation")
        return PropagationTrace(success=False, error_message=f"Gurobi error: {exc}")
    except (FileNotFoundError, OSError) as exc:
        logger.exception("I/O error during propagation")
        return PropagationTrace(success=False, error_message=f"I/O error: {exc}")
    finally:
        if owns_model and model is not None:
            import contextlib

            with contextlib.suppress(AttributeError, gp.GurobiError):
                model.dispose()

    if not rows:
        return PropagationTrace(
            success=False,
            error_message="No linear IIS constraints available to propagate.",
        )

    result = propagate_rows(rows, domains, language)
    result.success = True
    return result


def _build_problem(
    model: Any,
    iis_constraint_names: list[str],
) -> tuple[list[Row], dict[str, Domain]]:
    """Extract IIS rows + variable domains from a loaded Gurobi model.

    Rows are returned in the order of *iis_constraint_names* so the
    trace is deterministic and reads in a caller-controlled order.
    """
    by_name: dict[str, Any] = {}
    target = set(iis_constraint_names)
    for c in model.getConstrs():
        if c.ConstrName in target:
            by_name[c.ConstrName] = c

    rows: list[Row] = []
    domains: dict[str, Domain] = {}
    for name in iis_constraint_names:
        c = by_name.get(name)
        if c is None:
            continue
        grb_row = model.getRow(c)
        terms: dict[str, float] = {}
        for i in range(grb_row.size()):
            var = grb_row.getVar(i)
            coef = grb_row.getCoeff(i)
            terms[var.VarName] = terms.get(var.VarName, 0.0) + coef
            if var.VarName not in domains:
                vtype = getattr(var, "VType", "C")
                domains[var.VarName] = Domain(
                    lb=var.LB,
                    ub=var.UB,
                    is_integer=vtype in ("B", "I"),
                    default_lb_zero=(vtype == "C" and abs(var.LB) < _EPS),
                )
        rows.append(Row(name=name, terms=terms, sense=sense_symbol(c.Sense), rhs=c.RHS))
    return rows, domains


# ─────────────────────────────────────────────────────────────
# Pure FBBT core (no solver, fully testable)
# ─────────────────────────────────────────────────────────────


def propagate_rows(
    rows: list[Row],
    domains: dict[str, Domain],
    language: str = DEFAULT_LANGUAGE,
) -> PropagationTrace:
    """Run bound propagation to a fixed point or a contradiction.

    Mutates *domains* in place. Returns the ordered :class:`TraceStep`
    log and, if an empty domain was produced, the :class:`Contradiction`.
    The human-readable step/contradiction text is rendered in *language*
    (``"en"`` / ``"ja"``); variable names, constraint names, and numbers
    are language-neutral and passed through verbatim.
    """
    steps: list[TraceStep] = []
    contradiction: Contradiction | None = None
    tighten_count = 0

    changed = True
    while changed and contradiction is None and tighten_count < _MAX_TIGHTENINGS:
        changed = False
        for row in rows:
            for var, coef in row.terms.items():
                if coef == 0.0:
                    continue
                dom = domains[var]
                implied_lb, implied_ub = _implied_bounds(row, var, coef, domains)
                new_lb, new_ub = _intersect_and_round(dom, implied_lb, implied_ub)

                improved_lb = new_lb > dom.lb + _IMPROVE
                improved_ub = new_ub < dom.ub - _IMPROVE
                if not (improved_lb or improved_ub):
                    continue

                old = (dom.lb, dom.ub)
                dom.lb, dom.ub = new_lb, new_ub
                tighten_count += 1
                changed = True

                steps.append(
                    TraceStep(
                        constraint_name=row.name,
                        variable=var,
                        old_domain=old,
                        new_domain=(new_lb, new_ub),
                        explanation=_step_text(row.name, var, old, new_lb, new_ub, language),
                    )
                )

                if dom.lb > dom.ub + _EPS:
                    contradiction = _make_contradiction(
                        var, row.name, dom, upper_driven=improved_ub, language=language
                    )
                    break
            if contradiction is not None:
                break

    return PropagationTrace(
        steps=steps,
        contradiction=contradiction,
        reached_contradiction=contradiction is not None,
    )


def _term_interval(coef: float, dom: Domain) -> tuple[float, float]:
    """Min and max of ``coef·x`` over the variable's current domain."""
    if coef >= 0:
        return coef * dom.lb, coef * dom.ub
    return coef * dom.ub, coef * dom.lb


def _implied_bounds(
    row: Row,
    var: str,
    coef: float,
    domains: dict[str, Domain],
) -> tuple[float, float]:
    """Bounds on *var* implied by *row*, given the other terms' domains.

    Standard FBBT: isolate ``coef·var`` against the residual interval of
    the remaining terms, then divide by ``coef`` (flipping the sense when
    ``coef < 0``).
    """
    res_min = 0.0
    res_max = 0.0
    for other, c in row.terms.items():
        if other == var or c == 0.0:
            continue
        lo, hi = _term_interval(c, domains[other])
        res_min += lo
        res_max += hi

    implied_lb = -math.inf
    implied_ub = math.inf

    if row.sense in ("<=", "="):
        # coef·var <= rhs - res_min
        bound = row.rhs - res_min
        if coef > 0:
            implied_ub = bound / coef
        else:
            implied_lb = bound / coef

    if row.sense in (">=", "="):
        # coef·var >= rhs - res_max
        bound = row.rhs - res_max
        if coef > 0:
            implied_lb = bound / coef
        else:
            implied_ub = bound / coef

    return implied_lb, implied_ub


def _intersect_and_round(
    dom: Domain,
    implied_lb: float,
    implied_ub: float,
) -> tuple[float, float]:
    """Intersect the implied bounds with the current domain, rounding
    integer variables inward (ceil the lower, floor the upper)."""
    new_lb = max(dom.lb, implied_lb) if implied_lb > dom.lb else dom.lb
    new_ub = min(dom.ub, implied_ub) if implied_ub < dom.ub else dom.ub

    if dom.is_integer:
        if math.isfinite(new_lb):
            new_lb = math.ceil(new_lb - _EPS)
        if math.isfinite(new_ub):
            new_ub = math.floor(new_ub + _EPS)
    return new_lb, new_ub


def _make_contradiction(
    var: str,
    constraint_name: str,
    dom: Domain,
    upper_driven: bool,
    language: str = DEFAULT_LANGUAGE,
) -> Contradiction:
    """Build the contradiction record for an emptied domain.

    *upper_driven* indicates the newly implied upper bound dropped below
    the existing lower bound (vs. a lower bound rising above the upper).
    """
    lb_is_default = upper_driven and dom.default_lb_zero and abs(dom.lb) < _EPS

    if upper_driven:
        detail = tr(
            language,
            "forced_le",
            var=var,
            ub=_fmt(dom.ub),
            cons=constraint_name,
            lb=_fmt(dom.lb),
        )
        if lb_is_default:
            detail += tr(language, "default_lb_note")
    else:
        detail = tr(
            language,
            "forced_ge",
            var=var,
            lb=_fmt(dom.lb),
            cons=constraint_name,
            ub=_fmt(dom.ub),
        )
    detail += tr(language, "no_feasible")

    return Contradiction(
        variable=var,
        constraint_name=constraint_name,
        lower=dom.lb,
        upper=dom.ub,
        detail=detail,
        lb_is_default=lb_is_default,
    )


def _step_text(
    constraint_name: str,
    var: str,
    old: tuple[float, float],
    new_lb: float,
    new_ub: float,
    language: str = DEFAULT_LANGUAGE,
) -> str:
    """One-line rendering of a single forced implication.

    Only the "fixed to" connector is language-dependent; the ``≥``/``≤``/
    ``∈`` forms are pure arithmetic and read identically in any language.
    """
    if math.isfinite(new_lb) and abs(new_lb - new_ub) < _EPS:
        body = tr(language, "step_fixed", var=var, val=_fmt(new_lb))
    else:
        parts: list[str] = []
        if new_lb > old[0] + _IMPROVE:
            parts.append(f"{var} ≥ {_fmt(new_lb)}")
        if new_ub < old[1] - _IMPROVE:
            parts.append(f"{var} ≤ {_fmt(new_ub)}")
        body = " and ".join(parts) if parts else f"{var} ∈ [{_fmt(new_lb)}, {_fmt(new_ub)}]"
    return f"`{constraint_name}` ⟹ {body}"


def _fmt(x: float) -> str:
    """Format a bound, matching the skill's ``%.4g`` numeric style."""
    if x == math.inf:
        return "∞"
    if x == -math.inf:
        return "-∞"
    return f"{x:.4g}"
