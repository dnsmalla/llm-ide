"""
large_model_filter.py
─────────────────────
Large-model fast filter pipeline (Step 4 alternative for |IIS| > threshold).

Replaces Chinneck's O(N) deletion filter with a 5-phase pipeline that
reduces ~10,000 solver calls to ~50 regardless of IIS size.

Phases
──────
    1. Rule-based pre-filter (0 Gurobi calls)
       Checks each IIS constraint's activity range against its RHS.
       Constraints that are infeasible in isolation are "definitely
       essential" — they must appear in any IIS.  Remaining constraints
       become candidates for Phases 2–4.

    2. Farkas filter (0 extra calls — uses the existing infeasible solve)
       Drops constraints whose Farkas dual multiplier is zero.
       Typically eliminates 60–80 % of remaining candidates.

    3. Elastic filter — FeasRelax (1 LP solve)
       Solves a relaxation that minimises constraint violations (L1
       norm).  Only constraints with positive artificial-variable values
       (ArtP_<name> or ArtN_<name>) are kept.  Reduces remaining
       candidates to typically 5–50.

    4. QuickXplain (O(k·log(n/k)) calls, k = |IIS|, n = candidates)
       Divide-and-conquer minimal IIS isolation on the small candidate
       set produced by Phase 3.

    5. Verification
       Calls verify_subset_infeasible() to confirm the result is truly
       infeasible.  Falls back to Chinneck on Phase-3 candidates if the
       QuickXplain result is feasible (rare degenerate case).

Fallback behaviour
──────────────────
    • Phase 3 returns 0 candidates → fall back to Chinneck on full IIS.
    • Phase 4 result is feasible  → fall back to Chinneck on Phase-3 candidates.
    • Any GurobiError              → return DeletionFilterResult(success=False).
    • FarkasDual unavailable      → skip Phase 2, proceed to Phase 3.
"""

from __future__ import annotations

import contextlib
import logging
import math
import time
from pathlib import Path

from iis_summarization._gurobi import import_gurobi
from iis_summarization.errors import GurobiUnavailableError
from iis_summarization.farkas_filter import extract_farkas_candidates
from iis_summarization.ilp_reducer import verify_subset_infeasible
from iis_summarization.interfaces import ILargeModelFilter
from iis_summarization.models import DeletionFilterResult
from iis_summarization.quickxplain import QuickXplain

logger = logging.getLogger(__name__)

_EPS = 1e-9


class LargeModelFilter(ILargeModelFilter):
    """Default implementation of :class:`ILargeModelFilter`."""

    @classmethod
    def create(cls) -> ILargeModelFilter:
        """Factory returning the default :class:`LargeModelFilter`."""
        return cls()

    def minimize(
        self,
        lp_file: Path,
        iis_constraint_names: list[str],
        feasibility_timeout: int,
        budget_seconds: float | None = None,
    ) -> DeletionFilterResult:
        return _run_large_model_filter(
            lp_file=lp_file,
            iis_constraint_names=iis_constraint_names,
            feasibility_timeout=feasibility_timeout,
            budget_seconds=budget_seconds,
        )


def _run_large_model_filter(
    lp_file: Path,
    iis_constraint_names: list[str],
    feasibility_timeout: int,
    budget_seconds: float | None,
) -> DeletionFilterResult:
    start = time.perf_counter()
    result = DeletionFilterResult(success=False, large_model_pipeline_used=True)
    result.candidate_sizes["initial"] = len(iis_constraint_names)

    try:
        gp, GRB = import_gurobi()
    except GurobiUnavailableError as exc:
        result.error_message = str(exc)
        return result

    model = None
    try:
        model = gp.read(str(lp_file))
        model.setParam("OutputFlag", 0)
        model.setParam("TimeLimit", feasibility_timeout)

        # Build variable bounds map (used by Phase 1 rule-based filter).
        var_bounds: dict[str, tuple[float, float]] = {
            v.VarName: (v.LB, v.UB) for v in model.getVars()
        }

        # ── Phase 1: Rule-based pre-filter ─────────────────────────────
        definitely_essential, candidates = _phase1_rule_based(
            iis_constraint_names, model, var_bounds
        )
        result.phases_run.append("rule_based")
        result.candidate_sizes["after_rule_based"] = len(candidates)
        logger.info(
            "Phase 1 (rule-based): %d definitely-essential, %d candidates remain.",
            len(definitely_essential),
            len(candidates),
        )

        # Short-circuit: all constraints are trivially DATA-infeasible.
        if not candidates:
            result.minimal_iis = definitely_essential
            result.dropped_as_redundant = [
                n for n in iis_constraint_names if n not in set(definitely_essential)
            ]
            result.elapsed_seconds = time.perf_counter() - start
            result.success = True
            return result

        # ── Phase 2: Farkas filter ──────────────────────────────────────
        # FarkasDual is only populated when InfUnbdInfo=1 was set BEFORE
        # the solve — without it the attribute raises AttributeError and
        # the filter silently degrades to a no-op. Dual simplex (Method=1)
        # is the only algorithm guaranteed to produce the certificate
        # basis; barrier without crossover never does.
        model.setParam("InfUnbdInfo", 1)
        model.setParam("Method", 1)
        model.optimize()
        if model.status == GRB.INFEASIBLE:
            candidates = extract_farkas_candidates(model, candidates)
        result.phases_run.append("farkas")
        result.candidate_sizes["after_farkas"] = len(candidates)
        logger.info("Phase 2 (Farkas): %d candidates remain.", len(candidates))

        # Check budget.
        if budget_seconds is not None and (time.perf_counter() - start) > budget_seconds:
            logger.warning("Budget exhausted after Phase 2.")
            return _fallback_chinneck(
                lp_file, iis_constraint_names, feasibility_timeout, result, start, gp, GRB
            )

        # ── Phase 3: Elastic filter (FeasRelax) ────────────────────────
        elastic_candidates = _phase3_elastic(
            candidates, model, feasibility_timeout, gp, GRB
        )
        result.phases_run.append("elastic")
        result.candidate_sizes["after_elastic"] = len(elastic_candidates)
        logger.info("Phase 3 (elastic): %d candidates remain.", len(elastic_candidates))

        if not elastic_candidates:
            logger.warning(
                "Phase 3 returned 0 candidates — falling back to Chinneck "
                "on original %d IIS names.",
                len(iis_constraint_names),
            )
            return _fallback_chinneck(
                lp_file, iis_constraint_names, feasibility_timeout, result, start, gp, GRB
            )

        # Check budget. Fall back on the ORIGINAL IIS names: the elastic
        # candidates are not guaranteed to contain a complete IIS (the
        # L1-minimal relaxation may pick one of several alternative
        # optima), so running Chinneck on them alone can return a
        # feasible — i.e. wrong — "IIS".
        if budget_seconds is not None and (time.perf_counter() - start) > budget_seconds:
            logger.warning("Budget exhausted after Phase 3.")
            return _fallback_chinneck(
                lp_file, iis_constraint_names, feasibility_timeout, result, start, gp, GRB
            )

        # ── Phase 4: QuickXplain ────────────────────────────────────────
        qx_result = QuickXplain.find_iis(
            lp_file=lp_file,
            candidates=elastic_candidates,
            timeout=feasibility_timeout,
            gp=gp,
            GRB=GRB,
        )
        result.phases_run.append("quickxplain")
        logger.info("Phase 4 (QuickXplain): IIS size = %d.", len(qx_result))

        # ── Phase 5: Verify ─────────────────────────────────────────────
        final_iis = definitely_essential + qx_result
        verified = verify_subset_infeasible(lp_file, final_iis, timeout=feasibility_timeout)
        result.phases_run.append("verify")

        if not verified:
            # The elastic filter dropped a true IIS member (alternative
            # L1 optima relax a different constraint set than the IIS),
            # so the candidate narrowing cannot be trusted. Restart the
            # search from the ORIGINAL IIS names — correctness over speed.
            logger.warning(
                "Phase 5 verification failed — QuickXplain result is feasible. "
                "Falling back to Chinneck on the original %d IIS names.",
                len(iis_constraint_names),
            )
            return _fallback_chinneck(
                lp_file, iis_constraint_names, feasibility_timeout, result, start, gp, GRB
            )

        # Success.
        final_set = set(final_iis)
        result.minimal_iis = final_iis
        result.dropped_as_redundant = [n for n in iis_constraint_names if n not in final_set]
        result.candidate_sizes["final"] = len(final_iis)
        result.elapsed_seconds = time.perf_counter() - start
        result.success = True
        logger.info(
            "LargeModelFilter: reduced %d → %d constraints in %.1fs "
            "(phases: %s).",
            len(iis_constraint_names),
            len(final_iis),
            result.elapsed_seconds,
            ", ".join(result.phases_run),
        )
        return result

    except gp.GurobiError as exc:
        logger.exception("Gurobi error in LargeModelFilter")
        result.error_message = f"Gurobi error: {exc}"
        result.elapsed_seconds = time.perf_counter() - start
        return result
    finally:
        if model is not None:
            with contextlib.suppress(Exception):
                model.dispose()


def _phase1_rule_based(
    iis_names: list[str],
    model: object,
    var_bounds: dict[str, tuple[float, float]],
) -> tuple[list[str], list[str]]:
    """Split IIS names into definitely-essential and remaining candidates.

    A constraint is "definitely essential" if its LHS activity range
    cannot satisfy its RHS using variable bounds alone (DATA infeasibility).
    These must appear in any IIS, so we commit to them immediately.

    Returns (definitely_essential, candidates).
    """
    definitely_essential: list[str] = []
    candidates: list[str] = []
    iis_set = set(iis_names)

    try:
        for c in model.getConstrs():
            if c.ConstrName not in iis_set:
                continue

            sense = c.Sense   # "<", ">", "="
            rhs = c.RHS
            row = model.getRow(c)

            lhs_min = 0.0
            lhs_max = 0.0
            nan_detected = False
            for i in range(row.size()):
                var = row.getVar(i)
                coef = row.getCoeff(i)
                if abs(coef) < 1e-12:
                    continue
                lb, ub = var_bounds.get(var.VarName, (-1e100, 1e100))
                if coef >= 0:
                    lhs_min += coef * lb
                    lhs_max += coef * ub
                else:
                    lhs_min += coef * ub
                    lhs_max += coef * lb
                if math.isnan(lhs_min) or math.isnan(lhs_max):
                    nan_detected = True
                    break

            if nan_detected:
                # Free variables with mixed-sign coefficients — indeterminate.
                candidates.append(c.ConstrName)
                continue

            is_data_infeasible = False
            if sense == "<" and lhs_min > rhs + _EPS:
                is_data_infeasible = True
            elif sense == ">" and lhs_max < rhs - _EPS:
                is_data_infeasible = True
            elif sense == "=" and not (lhs_min - _EPS <= rhs <= lhs_max + _EPS):
                is_data_infeasible = True

            if is_data_infeasible:
                definitely_essential.append(c.ConstrName)
            else:
                candidates.append(c.ConstrName)

    except Exception as exc:
        logger.warning("Phase 1 rule-based filter failed (%s); using all names.", exc)
        return [], list(iis_names)

    return definitely_essential, candidates


def _phase3_elastic(
    candidates: list[str],
    model: object,
    timeout: int,
    gp: object,
    GRB: object,
    rounds: int = 3,
    penalty_multiplier: float = 10.0,
) -> list[str]:
    """Run iterative re-penalized FeasRelax on *candidates*; return the
    union of constraints that received positive slack in any round.

    A single L1 FeasRelax has alternative optima: when several
    constraint subsets achieve the same minimal total violation, one
    pass relaxes only one of them and true IIS members go unseen
    (Gurobi's documented limitation). Per Gurobi's guidance the cure is
    iterative re-penalization — multiply the penalty on each violated
    constraint and re-solve, so the next round breaks the tie toward a
    *different* subset. The union across rounds covers the IIS.

    Stops early once a round adds no new violated constraints. Returns
    all candidates unchanged if the very first solve fails (safe
    over-approximation); later-round failures return the union so far.
    """
    kept_union: set[str] = set()
    penalties: dict[str, float] = dict.fromkeys(candidates, 1.0)

    for round_idx in range(rounds):
        violated = _run_elastic_round(candidates, penalties, model, timeout, GRB)
        if violated is None:
            if not kept_union:
                logger.warning(
                    "Phase 3 elastic round 1 failed; returning all candidates."
                )
                return list(candidates)
            logger.warning(
                "Phase 3 elastic round %d failed; returning union of %d "
                "candidates from earlier rounds.",
                round_idx + 1,
                len(kept_union),
            )
            break

        new_names = violated - kept_union
        kept_union |= violated
        logger.info(
            "Phase 3 elastic round %d: %d violated (%d new).",
            round_idx + 1,
            len(violated),
            len(new_names),
        )
        if not new_names:
            break
        for name in violated:
            penalties[name] *= penalty_multiplier

    return [n for n in candidates if n in kept_union]


def _run_elastic_round(
    candidates: list[str],
    penalties: dict[str, float],
    model: object,
    timeout: int,
    GRB: object,
) -> set[str] | None:
    """One weighted FeasRelax solve; return the violated candidate names.

    Returns ``None`` when the solve fails or ends without an optimal
    solution, so the caller can distinguish "no violations" from
    "no answer".
    """
    elastic_model = None
    try:
        elastic_model = model.copy()
        elastic_model.setParam("OutputFlag", 0)
        elastic_model.setParam("TimeLimit", timeout)

        all_constrs = elastic_model.getConstrs()
        all_vars = elastic_model.getVars()

        # Gurobi convention: GRB.INFINITY forbids relaxing an element;
        # a penalty of 0 would make its violation FREE, silently
        # absorbing the infeasibility into non-candidates/bounds and
        # blinding the filter.
        forbid = GRB.INFINITY
        rhspen = [penalties.get(c.ConstrName, forbid) for c in all_constrs]
        lbpen = [forbid] * len(all_vars)
        ubpen = [forbid] * len(all_vars)

        # Zero out objective so phase-2 of feasRelax is trivially bounded.
        # Multi-objective models must be reduced to a pure feasibility
        # problem first — feasRelax rejects minrelax=True on them.
        if getattr(elastic_model, "NumObj", 0) > 1:
            elastic_model.NumObj = 0
        for v in all_vars:
            v.Obj = 0.0
        elastic_model.update()

        elastic_model.feasRelax(
            relaxobjtype=0,
            minrelax=True,
            vars=all_vars,
            lbpen=lbpen,
            ubpen=ubpen,
            constrs=all_constrs,
            rhspen=rhspen,
        )
        elastic_model.optimize()

        if elastic_model.status not in (
            GRB.OPTIMAL,
            GRB.SUBOPTIMAL,
        ):
            logger.warning(
                "Elastic round solve status = %d; treating as failed.",
                elastic_model.status,
            )
            return None

        art_vars = {
            v.VarName: v.X
            for v in elastic_model.getVars()
            if v.VarName.startswith(("ArtP_", "ArtN_"))
        }

        violated: set[str] = set()
        for name in candidates:
            pos = art_vars.get(f"ArtP_{name}", 0.0)
            neg = art_vars.get(f"ArtN_{name}", 0.0)
            if pos + neg > _EPS:
                violated.add(name)
        return violated

    except Exception as exc:
        logger.warning("Elastic round failed (%s).", exc)
        return None
    finally:
        if elastic_model is not None:
            with contextlib.suppress(Exception):
                elastic_model.dispose()


def _fallback_chinneck(
    lp_file: Path,
    names: list[str],
    feasibility_timeout: int,
    partial_result: DeletionFilterResult,
    start: float,
    gp: object,
    GRB: object,
) -> DeletionFilterResult:
    """Fall back to the standard Chinneck deletion filter on *names*."""
    from iis_summarization.deletion_filter import DeletionFilter

    logger.info(
        "Falling back to Chinneck deletion filter on %d candidates.", len(names)
    )
    partial_result.phases_run.append("fallback_chinneck")
    chinneck = DeletionFilter.create().minimize(
        lp_file=lp_file,
        iis_constraint_names=names,
        feasibility_timeout=feasibility_timeout,
    )
    chinneck.large_model_pipeline_used = True
    chinneck.phases_run = partial_result.phases_run
    chinneck.candidate_sizes = partial_result.candidate_sizes
    chinneck.candidate_sizes["fallback_chinneck_input"] = len(names)
    return chinneck
