"""Inspect a model file (.lp / .mps) to complement the log.

The log tells you how the solve *went*; the model tells you what was *solved* —
the true coefficient ranges and, crucially, WHERE the extreme coefficients live
(which constraint and variable), so a "rescale the model" recommendation can
point at the actual offending term.

``gurobipy`` is imported lazily so the package keeps working (log-only) without
it installed. Any failure degrades to ``None`` rather than aborting the run.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

MODEL_SUFFIXES = {".lp", ".mps", ".rew", ".rlp", ".ilp", ".bz2", ".gz", ".zip"}
# Cap the matrix scan so a huge model cannot stall the run; report when hit.
_NONZERO_SCAN_CAP = 5_000_000
# Big-M heuristic: a binary term is a candidate big-M when its |coeff| is large
# in absolute terms AND dominates the rest of the row.
_BIG_M_MIN_ABS = 1e3
_BIG_M_DOMINANCE = 10.0
_BIG_M_MAX_REPORT = 8


def inspect_model(lp_path: str | Path) -> dict[str, Any] | None:
    """Return a structural + coefficient summary of the model, or ``None`` if
    the model cannot be read (missing gurobipy, bad license, unreadable file)."""
    path = Path(lp_path)
    if not path.exists():
        log.warning("model file not found: %s", path)
        return None
    try:
        import gurobipy as gp
    except ImportError:
        log.warning("gurobipy not installed — skipping model (.lp) analysis")
        return None

    try:
        env = gp.Env(empty=True)
        env.setParam("OutputFlag", 0)
        env.start()
        model = gp.read(str(path), env=env)
    except gp.GurobiError as exc:
        log.warning("could not read model %s: %s", path, exc)
        return None

    try:
        return _summarize(model, gp, path)
    finally:
        model.dispose()
        env.dispose()


def _gen_constr_type_names(gp: Any) -> dict[int, str]:
    """Reverse map Gurobi GENCONSTR_<TYPE> int codes → 'TYPE' (version-robust)."""
    names: dict[int, str] = {}
    for attr in dir(gp.GRB):
        if attr.startswith("GENCONSTR_"):
            names[getattr(gp.GRB, attr)] = attr[len("GENCONSTR_"):]
    return names


def _classify(model: Any) -> tuple[str, bool]:
    """Return (model_class, is_linear) from Gurobi attribute semantics."""
    is_mip = bool(model.IsMIP)
    is_qp = bool(model.IsQP)
    is_qcp = bool(model.IsQCP)
    n_gen = model.NumGenConstrs
    # A nonlinear general constraint (function) makes it MINLP; the linear-izable
    # ones (max/min/abs/and/or/indicator/pwl) keep it MILP.
    if is_qcp:
        return ("MIQCP" if is_mip else "QCP"), False
    if is_qp:
        return ("MIQP" if is_mip else "QP"), False
    if n_gen > 0:
        return ("MINLP/MILP (general constraints)" if is_mip else "MINLP (general constraints)"), False
    if is_mip:
        return "MILP", False
    return "LP", True


def _summarize(model: Any, gp: Any, path: Path) -> dict[str, Any]:
    inf = gp.GRB.INFINITY
    model_class, is_linear = _classify(model)

    # General-constraint breakdown by subtype (ABS / INDICATOR / EXP / …).
    gen_breakdown: dict[str, int] = {}
    if model.NumGenConstrs:
        type_names = _gen_constr_type_names(gp)
        for gc in model.getGenConstrs():
            tname = type_names.get(gc.GenConstrType, f"TYPE_{gc.GenConstrType}")
            gen_breakdown[tname] = gen_breakdown.get(tname, 0) + 1

    nv, nc = model.NumVars, model.NumConstrs
    density = (model.NumNZs / (nv * nc)) if nv and nc else None

    info: dict[str, Any] = {
        "model_file": str(path),
        "model_class": model_class,
        "is_linear": is_linear,
        "sizes": {
            "rows": nc,
            "columns": nv,
            "nonzeros": model.NumNZs,
        },
        "density": density,
        "variable_types": {
            "continuous": model.NumVars - model.NumIntVars,
            "integer": model.NumIntVars,
            "binary": model.NumBinVars,
        },
        "obj_sense": "minimize" if model.ModelSense == gp.GRB.MINIMIZE else "maximize",
        "n_quad_constrs": model.NumQConstrs,
        "n_quad_obj_terms": model.NumQNZs,
        "n_sos": model.NumSOS,
        "n_gen_constrs": model.NumGenConstrs,
        "gen_constraints": gen_breakdown,
        "is_mip": bool(model.IsMIP),
    }

    # ── Matrix coefficient extremes (and WHERE they are) ──
    max_abs = 0.0
    min_abs = float("inf")
    max_loc: dict[str, Any] | None = None
    min_loc: dict[str, Any] | None = None
    scanned = 0
    capped = False
    for constr in model.getConstrs():
        row = model.getRow(constr)
        for i in range(row.size()):
            coeff = row.getCoeff(i)
            a = abs(coeff)
            if a == 0.0:
                continue
            scanned += 1
            if scanned > _NONZERO_SCAN_CAP:
                capped = True
                break
            if a > max_abs:
                max_abs = a
                max_loc = {"value": coeff, "constraint": constr.ConstrName,
                           "variable": row.getVar(i).VarName}
            if a < min_abs:
                min_abs = a
                min_loc = {"value": coeff, "constraint": constr.ConstrName,
                           "variable": row.getVar(i).VarName}
        if capped:
            break

    # ── Objective / bounds / RHS ranges ──
    obj_range = _abs_range(abs(v.Obj) for v in model.getVars() if v.Obj != 0.0)
    bounds_vals = []
    for v in model.getVars():
        if -inf < v.LB < inf and v.LB != 0.0:
            bounds_vals.append(abs(v.LB))
        if -inf < v.UB < inf and v.UB != 0.0:
            bounds_vals.append(abs(v.UB))
    bnd_range = _abs_range(iter(bounds_vals))
    rhs_range = _abs_range(abs(c.RHS) for c in model.getConstrs() if c.RHS != 0.0)

    stats: dict[str, list[float]] = {}
    if max_loc is not None and min_loc is not None:
        stats["matrix"] = [min_abs, max_abs]
    if obj_range is not None:
        stats["objective"] = [obj_range[0], obj_range[1]]
    if bnd_range is not None:
        stats["bounds"] = [bnd_range[0], bnd_range[1]]
    if rhs_range is not None:
        stats["rhs"] = [rhs_range[0], rhs_range[1]]

    info["coefficient_stats"] = stats
    info["matrix_extremes"] = {"max": max_loc, "min": min_loc}
    info["scan_capped"] = capped
    # Skip the (independent) big-M pass on a model so large the matrix scan was
    # already capped — it would re-walk the whole model uncapped.
    info["big_m_constraints"] = [] if capped else _detect_big_m(model, gp)
    return info


def _is_binary_like(var: Any, inf: float) -> bool:
    """Binary, or an integer variable restricted to {0,1}."""
    if var.VType == "B":
        return True
    return var.VType == "I" and var.LB == 0.0 and var.UB == 1.0


def _detect_big_m(model: Any, gp: Any) -> list[dict[str, Any]]:
    """Flag inequality rows whose dominant binary 'big-M' coefficient dwarfs the
    *reachable activity* of the rest of the row — a strong signal the M is loose.

    SAFETY: we deliberately do NOT prescribe a replacement M. The minimal valid
    M depends on which binary value deactivates the row and on the RHS, which
    varies by idiom; a wrong number could cut off the optimum. Instead we report
    how far the other terms can actually reach (``reachable_activity``) as
    evidence and advise the user to recompute the minimal M for their logic.
    Only emit when every other variable is finitely bounded, the reachable
    activity is strictly positive, and M dominates it."""
    inf = gp.GRB.INFINITY
    out: list[dict[str, Any]] = []
    scanned = 0
    for constr in model.getConstrs():
        if scanned > _NONZERO_SCAN_CAP:
            break
        if constr.Sense not in ("<", ">"):
            continue
        row = model.getRow(constr)
        n = row.size()
        scanned += n
        if n < 2:
            continue
        bigm_i = -1
        bigm_abs = 0.0
        other_max_abs = 0.0
        for i in range(n):
            coeff = row.getCoeff(i)
            a = abs(coeff)
            if _is_binary_like(row.getVar(i), inf) and a >= _BIG_M_MIN_ABS and a > bigm_abs:
                bigm_i, bigm_abs = i, a
        if bigm_i < 0:
            continue
        # Largest absolute activity the OTHER (non-big-M) terms can reach, over
        # their bounds. Needs finite bounds on every contributing variable.
        hi = lo = 0.0
        bounded = True
        for i in range(n):
            if i == bigm_i:
                continue
            coeff = row.getCoeff(i)
            var = row.getVar(i)
            other_max_abs = max(other_max_abs, abs(coeff))
            vlb, vub = var.LB, var.UB
            if vub >= inf or vlb <= -inf:
                bounded = False
                break
            hi += coeff * (vub if coeff > 0 else vlb)
            lo += coeff * (vlb if coeff > 0 else vub)
        if not bounded:
            continue
        reachable = max(abs(hi), abs(lo))
        # Require: M is genuinely large, dominates the other coefficients, and
        # dwarfs the reachable activity (so it is plausibly an unnecessarily
        # loose big-M). reachable must be > 0 so we never report a degenerate 0.
        if (
            reachable > 0.0
            and bigm_abs >= _BIG_M_DOMINANCE * max(other_max_abs, 1e-12)
            and bigm_abs >= _BIG_M_DOMINANCE * reachable
        ):
            out.append({
                "constraint": constr.ConstrName,
                "variable": row.getVar(bigm_i).VarName,
                "current_M": bigm_abs,
                "reachable_activity": reachable,
            })
        if len(out) >= _BIG_M_MAX_REPORT:
            break
    return out


def _abs_range(values: Any) -> tuple[float, float] | None:
    lo = float("inf")
    hi = 0.0
    seen = False
    for v in values:
        seen = True
        lo = min(lo, v)
        hi = max(hi, v)
    return (lo, hi) if seen else None
