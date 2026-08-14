"""
iis_runner.py
─────────────
Step 1 of the IIS analysis pipeline.

Loads a .lp model, confirms it is infeasible, runs ``computeIIS()``,
and writes the resulting .ilp file to disk.

Gurobi-recommended practices implemented here:

* **Tuning knobs** — optional ``IISMethod`` / ``NumericFocus``
  parameters for slow or numerically delicate IIS runs.
* **LP-relaxation-first for MIPs** — when the model is a MIP whose LP
  relaxation is already infeasible, the IIS is computed on the
  relaxation instead. Every sub-solve is then an LP (much faster) and
  any IIS of the relaxation is a valid infeasible subsystem of the
  original MIP. Only when the relaxation is feasible (infeasibility
  caused by integrality) does the IIS run on the MIP itself.
* **Numerical recovery** — "Cannot compute IIS on a feasible model"
  means the model sits at the edge of feasibility; the run is retried
  once with ``NumericFocus=3`` and ``Presolve=0``.
* **Attribute capture** — after ``computeIIS()`` the ``IISConstr``,
  ``IISLB``, ``IISUB``, and ``IISMinimal`` attributes are queried so
  downstream steps see which variable bounds participate, not just
  which constraints. Variables with the Gurobi default LB=0 inside the
  IIS are flagged (a common source of unintentional infeasibility).
"""

from __future__ import annotations

import contextlib
import logging
import time
from pathlib import Path

from iis_summarization._gurobi import import_gurobi
from iis_summarization._utils import range_slack_map, sense_symbol
from iis_summarization.errors import GurobiUnavailableError
from iis_summarization.interfaces import IIISRunner
from iis_summarization.models import IISBoundInfo, IISConstrInfo, IISRunResult

logger = logging.getLogger(__name__)


class IISRunner(IIISRunner):
    """Default implementation of :class:`IIISRunner` backed by gurobipy."""

    @classmethod
    def create(cls) -> IIISRunner:
        """Factory returning an :class:`IIISRunner`."""
        return cls()

    def run(
        self,
        lp_file: Path,
        timeout_seconds: int,
        output_dir: Path | None,
        iis_method: int | None = None,
        numeric_focus: int | None = None,
        threads: int | None = None,
        iis_target: int | None = None,
    ) -> IISRunResult:
        return _run_iis_impl(
            lp_file,
            timeout_seconds,
            output_dir,
            iis_method,
            numeric_focus,
            threads,
            iis_target,
        )


def run_iis(
    lp_file: str | Path,
    timeout_seconds: int = 300,
    output_dir: str | Path | None = None,
    iis_method: int | None = None,
    numeric_focus: int | None = None,
    threads: int | None = None,
    iis_target: int | None = None,
) -> IISRunResult:
    """
    Functional convenience wrapper around :class:`IISRunner`.

    Parameters
    ----------
    lp_file
        Path to the original .lp model.
    timeout_seconds
        Wall-clock limit passed to Gurobi for the IIS computation.
    output_dir
        Directory to write the .ilp file (defaults to the LP's parent).
    iis_method
        Gurobi ``IISMethod`` parameter (0–3). ``None`` keeps the
        default (-1, automatic). 1 is conservative, 2 aggressive,
        3 focuses on bound conflicts.
    numeric_focus
        Gurobi ``NumericFocus`` parameter (0–3). Higher values trade
        speed for numerical stability.
    threads
        Gurobi ``Threads`` parameter. The IIS outer loop is inherently
        sequential, but extra threads speed up each subproblem solve on
        large models.
    iis_target
        Callback-based early exit: terminate ``computeIIS`` as soon as
        the live ``IIS_CONSTRMAX`` upper bound drops to this value. The
        partial result is guaranteed infeasible (just not minimal) —
        the downstream reduction steps minimize it.

    Returns
    -------
    IISRunResult
    """
    lp_path = Path(lp_file)
    out_dir = Path(output_dir) if output_dir is not None else None
    return IISRunner.create().run(
        lp_path, timeout_seconds, out_dir, iis_method, numeric_focus, threads, iis_target
    )


def run_seeded_iis(
    lp_file: str | Path,
    seed_names: list[str],
    output_dir: str | Path,
    feasibility_timeout: int = 30,
) -> IISRunResult | None:
    """Daily warm-start: reuse a previous run's IIS names as today's
    candidate set, skipping ``computeIIS`` entirely.

    Gurobi-recommended pattern for structurally identical models whose
    data changes between runs — with the documented mandatory guard:
    the seed subsystem must be verified still infeasible under TODAY's
    data first. Returns ``None`` when the seed is empty or no longer
    conflicting (caller falls back to a fresh computeIIS); otherwise
    returns a successful :class:`IISRunResult` whose ``.ilp`` was
    written from TODAY's model (never yesterday's constraint bodies)
    with ``used_seed=True``. The seed is treated as non-minimal — the
    downstream reduction steps minimize it as usual.
    """
    from iis_summarization.ilp_reducer import verify_subset_infeasible

    if not seed_names:
        return None

    lp_path = Path(lp_file)
    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    if not verify_subset_infeasible(lp_path, seed_names, timeout=feasibility_timeout):
        logger.info(
            "Seed IIS (%d constraint(s)) is NOT infeasible under today's "
            "data — discarding the seed and falling back to computeIIS.",
            len(seed_names),
        )
        return None

    try:
        gp, _GRB = import_gurobi()
    except GurobiUnavailableError as exc:
        logger.warning("Seeded IIS unavailable: %s", exc)
        return None

    model = None
    try:
        model = gp.read(str(lp_path))
        model.setParam("OutputFlag", 0)
        keep = set(seed_names)
        for c in list(model.getConstrs()):
            if c.ConstrName not in keep:
                model.remove(c)
        model.update()

        # Gurobi only writes .ilp for a computed IIS; the .ilp format is
        # plain LP text, so write as .lp and move into place.
        tmp_lp = out_dir / f"{lp_path.stem}_seed_subset.lp"
        model.write(str(tmp_lp))
        ilp_path = out_dir / f"{lp_path.stem}_iis.ilp"
        tmp_lp.replace(ilp_path)

        result = IISRunResult(success=True)
        result.ilp_file = ilp_path
        result.used_seed = True
        result.iis_is_minimal = False
        logger.info(
            "Seed IIS verified still infeasible — wrote %s from today's "
            "model (%d constraint(s)); computeIIS skipped.",
            ilp_path,
            len(seed_names),
        )
        return result
    except gp.GurobiError as exc:
        logger.warning("Seeded IIS failed (%s); falling back to computeIIS.", exc)
        return None
    finally:
        if model is not None:
            with contextlib.suppress(AttributeError, gp.GurobiError):
                model.dispose()


def _is_borderline_iis_error(message: str) -> bool:
    """True when *message* is Gurobi's "model is at the edge of feasibility" error.

    ``optimize()`` said INFEASIBLE but ``computeIIS()`` disagrees —
    per Gurobi's docs this is a numerical-tolerance issue, addressed by
    re-running with maximum NumericFocus and presolve disabled.
    """
    return "cannot compute iis on a feasible model" in message.lower()


def _make_iis_target_callback(gp: object, GRB: object, target: int):
    """Build a computeIIS callback that terminates once the live
    ``IIS_CONSTRMAX`` upper bound drops to *target*.

    Per Gurobi: terminating from the IIS callback is legal, the partial
    subsystem stays guaranteed infeasible (``IISMinimal=0``), and all
    IIS attributes remain queryable — the downstream reduction steps
    minimize the result anyway.
    """

    def _cb(model: object, where: int) -> None:
        if where != GRB.Callback.IIS:  # type: ignore[attr-defined]
            return
        with contextlib.suppress(Exception):
            cmax = model.cbGet(GRB.Callback.IIS_CONSTRMAX)  # type: ignore[attr-defined]
            if cmax <= target:
                logger.info(
                    "IIS callback: candidate ceiling %d ≤ target %d — "
                    "terminating computeIIS early (partial IIS is still "
                    "guaranteed infeasible).",
                    cmax,
                    target,
                )
                model.terminate()  # type: ignore[attr-defined]

    return _cb


def _compute_iis_with_recovery(
    model: object,
    gp: object,
    callback: object | None = None,
) -> None:
    """Run ``computeIIS()``; on a borderline-feasibility error, retry once
    with ``NumericFocus=3`` and ``Presolve=0`` (Gurobi's recommendation)."""
    try:
        model.computeIIS(callback)
        return
    except gp.GurobiError as exc:  # type: ignore[attr-defined]
        if not _is_borderline_iis_error(str(exc)):
            raise
        logger.warning(
            "computeIIS reported a feasible model on an INFEASIBLE solve — "
            "model is numerically borderline. Retrying with NumericFocus=3 "
            "and Presolve=0."
        )
    model.setParam("NumericFocus", 3)
    model.setParam("Presolve", 0)
    model.reset()
    model.optimize()
    model.computeIIS(callback)


def _screen_numerics(model: object) -> tuple[list[str], bool]:
    """Proactive numerics screen per Gurobi's published scaling guidance.

    Recommended ranges (docs.gurobi.com, "Tolerances and User-Scaling"):
    matrix coefficients ideally within [1e-3, 1e6] and spanning no more
    than six orders of magnitude (nine is the hard guideline); RHS and
    bounds on the order of 1e6 or less. Outside these ranges the IIS
    membership itself can be a numerical artifact.

    Returns ``(warnings, severe)`` — *severe* is True when the matrix
    coefficient ratio exceeds the 1e9 hard guideline, in which case the
    whole diagnosis must be treated as LOW CONFIDENCE (per Gurobi,
    ``computeIIS`` operates on the original UNSCALED data, so internal
    scaling cannot repair this — only user-side rescaling can).
    """
    warnings: list[str] = []
    severe = False
    inf_cutoff = 1e29  # treat anything near GRB.INFINITY as "no finite bound"

    def _attr(name: str) -> float | None:
        try:
            return float(getattr(model, name))
        except Exception:  # noqa: BLE001 — attr may be missing or unqueryable
            return None

    max_coeff = _attr("MaxCoeff")
    min_coeff = _attr("MinCoeff")
    if max_coeff and min_coeff and min_coeff > 0:
        ratio = max_coeff / min_coeff
        if ratio > 1e9:
            severe = True
            warnings.append(
                f"LOW CONFIDENCE: matrix coefficients span {ratio:.1e} "
                f"(max {max_coeff:.1e} / min {min_coeff:.1e}) — beyond "
                "Gurobi's 1e9 guideline. computeIIS works on the original "
                "unscaled data, so IIS membership may be a numerical "
                "artifact. Rescale the model data (target range "
                "[1e-3, 1e6]) and re-run before acting on this diagnosis."
            )
        elif ratio > 1e6:
            warnings.append(
                f"Matrix coefficients span {ratio:.1e} — beyond Gurobi's "
                "ideal six orders of magnitude. Consider rescaling "
                "(target range [1e-3, 1e6])."
            )

    max_rhs = _attr("MaxRHS")
    if max_rhs and max_rhs > 1e6:
        warnings.append(
            f"Largest RHS magnitude is {max_rhs:.1e} — Gurobi recommends "
            "keeping RHS values at 1e6 or less."
        )

    max_bound = _attr("MaxBound")
    if max_bound and 1e6 < max_bound < inf_cutoff:
        warnings.append(
            f"Largest finite variable bound is {max_bound:.1e} — Gurobi "
            "recommends keeping bounds at 1e6 or less."
        )

    return warnings, severe


def _detect_nonlinear(model: object, result: IISRunResult) -> None:
    """Record whether the model has constraint types feasRelax cannot relax."""
    try:
        result.has_nonlinear_constraints = bool(
            getattr(model, "NumQConstrs", 0)
            or getattr(model, "NumSOS", 0)
            or getattr(model, "NumGenConstrs", 0)
        )
    except Exception:
        result.has_nonlinear_constraints = False


def _capture_nonlinear_iis_members(model: object, result: IISRunResult) -> None:
    """Query IISQConstr / IISSOS / IISGenConstr membership (best-effort).

    General constraints are labeled by type: only true indicators get the
    ``indicator:`` prefix (they have a numeric remediation, Step 7b);
    every other general-constraint type — MIN/MAX/ABS and especially
    function approximations, whose IIS membership Gurobi documents as
    potentially unreliable — is labeled ``general:``.
    """
    try:
        for qc in model.getQConstrs():
            if qc.IISQConstr:
                result.nonlinear_iis_members.append(f"quadratic: {qc.QCName}")
    except Exception:  # noqa: BLE001 — attribute may not exist on old versions
        pass
    try:
        for i, sos in enumerate(model.getSOSs()):
            if sos.IISSOS:
                result.nonlinear_iis_members.append(f"SOS: #{i}")
    except Exception:  # noqa: BLE001
        pass
    try:
        _gp, GRB = import_gurobi()
        for gc in model.getGenConstrs():
            if not gc.IISGenConstr:
                continue
            kind = (
                "indicator"
                if gc.GenConstrType == GRB.GENCONSTR_INDICATOR
                else "general"
            )
            result.nonlinear_iis_members.append(f"{kind}: {gc.GenConstrName}")
    except Exception:  # noqa: BLE001
        pass


def _capture_iis_attributes(model: object, result: IISRunResult, gp: object) -> None:
    """Populate IIS membership details by querying Gurobi attributes.

    Best-effort: a failure here must never sink an otherwise successful
    IIS run, so errors are logged and swallowed.
    """
    try:
        slack_map = range_slack_map(model)
        for c in model.getConstrs():
            if not c.IISConstr:
                continue
            result.iis_constraints.append(
                IISConstrInfo(
                    name=c.ConstrName,
                    sense=sense_symbol(c.Sense),
                    rhs=c.RHS,
                    expr=str(model.getRow(c)),
                )
            )
        for v in model.getVars():
            if v.IISLB:
                result.iis_bounds.append(
                    IISBoundInfo(
                        varname=v.VarName,
                        bound_type="lb",
                        bound_value=v.LB,
                        range_of=slack_map.get(v.VarName, ""),
                    )
                )
                # Gurobi defaults variable lower bounds to 0. An LB=0
                # inside the IIS often means the modeller forgot to
                # declare the variable free / negative-capable. Internal
                # range slacks always have LB=0 by construction — skip.
                if v.LB == 0.0 and v.VarName not in slack_map:
                    result.has_default_lb_issues.append(v.VarName)
            if v.IISUB:
                result.iis_bounds.append(
                    IISBoundInfo(
                        varname=v.VarName,
                        bound_type="ub",
                        bound_value=v.UB,
                        range_of=slack_map.get(v.VarName, ""),
                    )
                )
        with contextlib.suppress(AttributeError, gp.GurobiError):  # type: ignore[attr-defined]
            result.iis_is_minimal = bool(model.IISMinimal == 1)
        _capture_nonlinear_iis_members(model, result)
    except (AttributeError, gp.GurobiError) as exc:  # type: ignore[attr-defined]
        logger.warning("IIS attribute capture failed (non-fatal): %s", exc)


def _run_iis_impl(
    lp_file: Path,
    timeout_seconds: int,
    output_dir: Path | None,
    iis_method: int | None = None,
    numeric_focus: int | None = None,
    threads: int | None = None,
    iis_target: int | None = None,
) -> IISRunResult:
    out_dir = output_dir if output_dir is not None else lp_file.parent
    out_dir.mkdir(parents=True, exist_ok=True)

    result = IISRunResult(success=False)

    try:
        gp, GRB = import_gurobi()
    except GurobiUnavailableError as exc:
        result.error_message = str(exc)
        return result

    model = None
    relaxed = None
    try:
        model = gp.read(str(lp_file))
        model.setParam("OutputFlag", 0)
        model.setParam("TimeLimit", timeout_seconds)
        if iis_method is not None:
            model.setParam("IISMethod", iis_method)
        if numeric_focus is not None:
            model.setParam("NumericFocus", numeric_focus)
        if threads is not None:
            # The IIS outer loop is sequential (per Gurobi), but each
            # subproblem solve can still use multiple threads.
            model.setParam("Threads", threads)

        # Proactive screens (static attributes only — no solve needed):
        # numerics health per Gurobi's scaling guidelines, and constraint
        # types that feasRelax cannot relax (quadratic / SOS / general).
        _detect_nonlinear(model, result)
        result.numerics_warnings, numerics_severe = _screen_numerics(model)
        if numerics_severe:
            # Gurobi's recommended cheap first attempt for a >1e9 ratio:
            # aggressive internal scaling + maximum numerical care makes
            # the optimize() feasibility VERDICT more trustworthy (it
            # cannot make the IIS itself trustworthy — that needs
            # user-side rescaling).
            model.setParam("ScaleFlag", 2)
            if numeric_focus is None:
                model.setParam("NumericFocus", 3)
            result.numerics_warnings.append(
                "Mitigation applied: ScaleFlag=2 and NumericFocus=3 for "
                "the feasibility verdict. This does NOT make the IIS "
                "itself reliable on badly scaled data."
            )
        for w in result.numerics_warnings:
            logger.warning("Numerics screen: %s", w)

        # Confirm the model is actually infeasible before running computeIIS.
        model.optimize()
        result.model_status = model.status

        # Gurobi returns INF_OR_UNBD when presolve cannot distinguish
        # infeasibility from unboundedness. Per the Gurobi docs this is
        # resolved by disabling dual reductions and re-solving — we must
        # end up with either INFEASIBLE or UNBOUNDED to proceed.
        if model.status == GRB.INF_OR_UNBD:
            logger.info(
                "Initial solve returned INF_OR_UNBD — re-solving with "
                "DualReductions=0 to disambiguate."
            )
            model.reset()
            model.setParam("DualReductions", 0)
            model.optimize()
            result.model_status = model.status

        if model.status == GRB.OPTIMAL:
            result.error_message = "Model is FEASIBLE (status OPTIMAL). Nothing to diagnose."
            return result

        if model.status == GRB.UNBOUNDED:
            result.error_message = (
                "Model is UNBOUNDED, not infeasible. The objective can "
                "drift to ±∞ along a ray of free variables. Add finite "
                "bounds to the variables that participate in the "
                "objective or in equality chains that reach it, then "
                "re-run this skill. See Gurobi's Model.UnbdRay attribute "
                "for the exact ray direction."
            )
            return result

        if model.status == GRB.TIME_LIMIT:
            result.timed_out = True
            result.error_message = (
                f"Feasibility solve hit the {timeout_seconds}s time limit "
                "before proving infeasibility."
            )
            return result

        if model.status != GRB.INFEASIBLE:
            result.error_message = (
                f"Model status is {model.status}, not INFEASIBLE. "
                "Ensure the model is strictly infeasible (check unboundedness)."
            )
            return result

        # ── LP-relaxation-first routing for MIPs (Gurobi Strategy 4) ──
        # If the LP relaxation is itself infeasible, compute the IIS on
        # the relaxation: every IIS sub-solve becomes an LP and the
        # result is a valid infeasible subsystem of the original MIP.
        # If the relaxation is feasible, the infeasibility comes from
        # integrality and the IIS must be computed on the MIP itself.
        # Skipped for models with general/SOS/quadratic constraints:
        # Model.relax() only drops integrality, which is not a proper
        # relaxation in their presence (e.g. an indicator constraint
        # with a continuous trigger variable is undefined).
        target = model
        if model.IsMIP and not result.has_nonlinear_constraints:
            relaxed = model.relax()
            relaxed.setParam("OutputFlag", 0)
            relaxed.setParam("TimeLimit", timeout_seconds)
            relaxed.setParam("DualReductions", 0)
            relaxed.optimize()
            if relaxed.status == GRB.INFEASIBLE:
                logger.info(
                    "MIP's LP relaxation is already infeasible — computing "
                    "the IIS on the relaxation (all-LP, much faster)."
                )
                target = relaxed
                result.used_lp_relaxation = True
            else:
                logger.info(
                    "MIP's LP relaxation is feasible (status %d) — the "
                    "infeasibility involves integrality; computing the IIS "
                    "on the original MIP.",
                    relaxed.status,
                )

        iis_callback = (
            _make_iis_target_callback(gp, GRB, iis_target)
            if iis_target is not None
            else None
        )

        start = time.perf_counter()
        _compute_iis_with_recovery(target, gp, iis_callback)
        elapsed = time.perf_counter() - start
        result.elapsed_seconds = elapsed

        # Gurobi sets status == TIME_LIMIT if computeIIS itself timed out.
        # Per Gurobi's guidance a TimeLimit hit still yields a usable
        # NON-minimal IIS — salvage it instead of failing: the downstream
        # reduction steps (Chinneck / fast pipeline) minimize it anyway.
        if target.status == GRB.TIME_LIMIT:
            result.timed_out = True
            try:
                ilp_path = out_dir / f"{lp_file.stem}_iis.ilp"
                target.write(str(ilp_path))
                _capture_iis_attributes(target, result, gp)
                result.iis_is_minimal = False
                result.success = True
                result.ilp_file = ilp_path
                logger.warning(
                    "computeIIS() hit the %ds time limit — salvaged a "
                    "NON-minimal IIS (%d constraint(s)); downstream "
                    "reduction will minimize it.",
                    timeout_seconds,
                    len(result.iis_constraints),
                )
            except gp.GurobiError as exc:
                result.error_message = (
                    f"computeIIS() hit the {timeout_seconds}s time limit "
                    f"and no partial IIS could be salvaged ({exc})."
                )
            return result

        ilp_path = out_dir / f"{lp_file.stem}_iis.ilp"
        target.write(str(ilp_path))

        _capture_iis_attributes(target, result, gp)

        # Per Gurobi: computeIIS does NOT change model.Status, so early
        # termination (TimeLimit / callback) is silent at the status
        # level — IISMinimal is the only reliable partial-result signal.
        # The partial subsystem is still guaranteed infeasible.
        if result.iis_is_minimal is False:
            logger.warning(
                "computeIIS returned a NON-minimal IIS (%d constraint(s) — "
                "early termination or filtering). It is guaranteed "
                "infeasible; downstream reduction will minimize it.",
                len(result.iis_constraints),
            )

        result.success = True
        result.ilp_file = ilp_path
        return result

    except gp.GurobiError as exc:
        logger.exception("Gurobi error during IIS computation")
        result.error_message = f"Gurobi error: {exc}"
    except (FileNotFoundError, OSError) as exc:
        logger.exception("I/O error during IIS computation")
        result.error_message = f"I/O error: {exc}"
    finally:
        # Best-effort cleanup of the model objects if they were created.
        for m in (relaxed, model):
            if m is not None:
                with contextlib.suppress(AttributeError, gp.GurobiError):
                    m.dispose()

    return result
