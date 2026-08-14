"""Assess a parsed Gurobi log: derive solver-health findings + tuning levers.

Thresholds follow Gurobi's documented guidance (verified via the Gurobi
knowledge base):

* coefficient range ratio  max/min :  <=1e6 ideal, 1e6–1e9 monitor,
  1e9–1e12 numerical risk, >1e12 high risk;
* a near-zero optimality gap at termination means the run proved optimality;
  a non-zero gap at a TIME_LIMIT / WORK_LIMIT stop means it did not.
"""

from __future__ import annotations

from typing import Any, TypedDict

from . import reformulations
from .recommendations import CATALOG, Lever

# Coefficient range-ratio thresholds (max/min absolute coefficient).
RATIO_MONITOR = 1e6
RATIO_RISK = 1e9
RATIO_HIGH_RISK = 1e12
# Formulation thresholds (Gurobi guidance).
DENSE_FRACTION = 0.10       # NumNZs/(rows*cols) above this = dense
BIG_M_BOUND = 1e7           # bound magnitude that may be a loose big-M
BIG_M_RHS = 1e6             # RHS magnitude that may be a loose big-M
OVERSIZE_PRESOLVE = 0.30    # presolve removing >30% ⇒ model larger than needed

# Warning substrings serious enough to escalate to critical on their own,
# independent of the matrix-range ratio.
_CRITICAL_WARNING_SUBSTRINGS: tuple[str, ...] = (
    "large matrix coefficient range", "large quadratic", "large objective",
    "large bounds", "large rhs", "unscaled", "violation",
)
# Default Gurobi MIPGap; a gap above this at a non-optimal stop is "open".
DEFAULT_MIPGAP_PCT = 1e-2


class Finding(TypedDict, total=False):
    id: str
    severity: str  # "critical" | "warning" | "info"
    title: str
    detail: str
    levers: list[Lever]


def _ratio(rng: list[float] | None) -> float | None:
    if not rng:
        return None
    lo, hi = abs(rng[0]), abs(rng[1])
    if lo <= 0.0:
        return None
    return hi / lo


def _ratio_severity(ratio: float) -> str | None:
    if ratio > RATIO_HIGH_RISK:
        return "critical"
    if ratio > RATIO_RISK:
        return "warning"
    if ratio > RATIO_MONITOR:
        return "info"
    return None


def assess(
    parsed: dict[str, Any], model_info: dict[str, Any] | None = None
) -> dict[str, Any]:
    """Return ``{findings: [...], healthy: bool}`` for a parsed log.

    When ``model_info`` (from inspecting the .lp/.mps) is supplied, its
    coefficient ranges are ground truth and its matrix extremes let the
    numerical finding name the offending constraint/variable."""
    findings: list[Finding] = []
    model_info = model_info or {}
    term = parsed.get("termination") or {}

    # Coefficient ranges: prefer the model (exact) over the log when both exist.
    log_stats = parsed.get("coefficient_stats") or {}
    model_stats = model_info.get("coefficient_stats") or {}
    stats = {**log_stats, **model_stats}

    # ── 1. Numerical conditioning from the matrix range ratio ──
    matrix_ratio = _ratio(stats.get("matrix"))
    if matrix_ratio is not None:
        sev = _ratio_severity(matrix_ratio)
        if sev is not None:
            detail = (
                f"Matrix coefficients span a ratio of ~{matrix_ratio:.0e} "
                f"({stats['matrix'][0]:g} … {stats['matrix'][1]:g}). "
                "Above 1e9 this risks round-off error; above 1e12 it is high risk "
                "(IEEE double keeps ~15–16 significant digits)."
            )
            extremes = model_info.get("matrix_extremes") or {}
            hi, lo = extremes.get("max"), extremes.get("min")
            if hi and lo:
                detail += (
                    f" Largest |coeff| is {hi['value']:g} on `{hi['variable']}` in "
                    f"constraint `{hi['constraint']}`; smallest is {lo['value']:g} on "
                    f"`{lo['variable']}` in `{lo['constraint']}` — rescale so these are closer."
                )
            findings.append({
                "id": "numerical",
                "severity": sev,
                "title": "Wide constraint-matrix coefficient range",
                "detail": detail,
                "levers": CATALOG["numerical"],
            })

    # ── 1b. Cross-check: log vs model coefficient range disagree ──
    log_m = _ratio(log_stats.get("matrix"))
    model_m = _ratio(model_stats.get("matrix"))
    if log_m is not None and model_m is not None:
        log_rng, model_rng = log_stats["matrix"], model_stats["matrix"]
        if (abs(log_rng[0] - model_rng[0]) > 1e-9 * max(1.0, abs(model_rng[0]))
                or abs(log_rng[1] - model_rng[1]) > 1e-9 * max(1.0, abs(model_rng[1]))):
            findings.append({
                "id": "log_model_mismatch",
                "severity": "info",
                "title": "Log and model coefficient ranges differ",
                "detail": (
                    f"The log's matrix range ({log_rng[0]:g}, {log_rng[1]:g}) does not "
                    f"match the model file's ({model_rng[0]:g}, {model_rng[1]:g}) — the "
                    "log may have been produced from a different model or build."
                ),
                "levers": [],
            })

    # ── 2. Any literal Warning: line Gurobi printed ──
    warnings = parsed.get("warnings") or []
    if warnings:
        # Critical if the matrix range is already high-risk, OR a warning is
        # itself high-signal (coefficient-range / unscaled-violation classes).
        critical_numeric = any(
            f["id"] == "numerical" and f["severity"] == "critical" for f in findings
        )
        critical_warning = any(
            sub in w.lower() for w in warnings for sub in _CRITICAL_WARNING_SUBSTRINGS
        )
        findings.append({
            "id": "solver_warnings",
            "severity": "critical" if (critical_numeric or critical_warning) else "warning",
            "title": f"Gurobi printed {len(warnings)} warning(s)",
            "detail": "; ".join(warnings[:6]),
            "levers": CATALOG["numerical"],
        })

    # ── 3. Optimality / termination ──
    status = term.get("status")
    gap = term.get("gap_pct")
    if status == "OPTIMAL":
        findings.append({
            "id": "optimal",
            "severity": "info",
            "title": "Proven optimal",
            "detail": "The solver closed the gap within tolerance; the reported objective is optimal.",
            "levers": [],
        })
    elif status in ("TIME_LIMIT", "WORK_LIMIT"):
        gtxt = f"{gap:g}%" if gap is not None else "unknown"
        # A multi-solve node-log mixes trajectories — don't trust stall detection.
        node_log = [] if parsed.get("multiple_solves") else (parsed.get("node_log") or [])
        stall = _analyze_stall(node_log)
        levers = CATALOG["time_limit"] + stall["levers"]
        findings.append({
            "id": "time_limit",
            "severity": "warning",
            "title": f"Stopped at the {'time' if status == 'TIME_LIMIT' else 'work'} limit "
                     f"with a {gtxt} gap",
            "detail": (
                "Optimality was NOT proven: the best solution may be improvable, and the "
                f"true optimum is within {gtxt} of it. " + stall["detail"]
            ),
            "levers": levers,
        })
    elif status in ("INFEASIBLE", "INF_OR_UNBD"):
        findings.append({
            "id": "infeasible",
            "severity": "critical",
            "title": "Model reported infeasible",
            "detail": "There is no feasible solution to explain — diagnose which constraints "
                      "conflict with an IIS (see the iis-summarization skill).",
            "levers": [],
        })
    elif status == "UNBOUNDED":
        findings.append({
            "id": "unbounded",
            "severity": "critical",
            "title": "Model is unbounded",
            "detail": "The objective can improve without limit — a bound or constraint is missing.",
            "levers": [],
        })
    elif status == "SUBOPTIMAL":
        findings.append({
            "id": "suboptimal",
            "severity": "warning",
            "title": "Sub-optimal termination",
            "detail": "Barrier converged but crossover did not reach a basic optimum; "
                      "the solution may be interior-optimal but not vertex-optimal.",
            "levers": CATALOG["slow_lp"],
        })

    # ── 4. Slow root relaxation dominating runtime → LP/barrier levers ──
    root = parsed.get("root_relaxation")
    runtime = term.get("runtime_sec")
    if root and runtime and runtime > 5.0 and root.get("seconds", 0) > 0.5 * runtime:
        findings.append({
            "id": "slow_lp",
            "severity": "info",
            "title": "Root relaxation dominates the runtime",
            "detail": (
                f"The root LP took {root['seconds']:g}s of {runtime:g}s total — the "
                "continuous relaxation, not the search, is the bottleneck."
            ),
            "levers": CATALOG["slow_lp"],
        })

    # ── 5. Multi-objective / multi-scenario logs: single-valued metrics and the
    # stall verdict reflect only the last solve; flag it.
    if parsed.get("multiple_solves"):
        if parsed.get("multi_objective_marker"):
            detail = ("This is a multi-objective / multi-scenario run. The status, gap and "
                      "node-log trajectory above reflect only the LAST objective/scenario — "
                      "interpret them per-objective, not for the whole run.")
        else:
            detail = ("More than one 'Best objective' summary was found — the log holds either "
                      "multiple objectives/scenarios or several solves of the model. The status, "
                      "gap and node-log above reflect only the LAST solve.")
        findings.append({
            "id": "multi_objective", "severity": "info",
            "title": "Log contains multiple objectives, scenarios, or solves",
            "detail": detail, "levers": [],
        })

    # ── 6. Structure / linearity advice (only when the model file was read) ──
    findings.extend(_structure_findings(model_info, parsed, stats))

    # Healthy = nothing worse than informational. An empty finding list (a clean
    # solve with nothing notable) counts as healthy.
    healthy = all(f["severity"] == "info" for f in findings)
    return {"findings": findings, "healthy": healthy}


def _analyze_stall(node_log: list[dict[str, Any]]) -> dict[str, Any]:
    """From the node-log time series, decide whether the incumbent (primal) or
    the dual bound stalled in the latter half of the run, and pick the matching
    levers. Removes the need to hedge between MIPFocus 1 and 3."""
    if len(node_log) < 3:
        # Not enough trajectory to tell — fall back to giving more budget + both.
        return {
            "type": "unknown",
            "detail": "Give it more budget, relax MIPGap if the gap is acceptable, or push "
                      "both bound and incumbent.",
            "levers": CATALOG["slow_mip_dual"] + CATALOG["slow_mip_primal"],
        }
    # "Stalled" means a FLAT TAIL: the metric has not changed over the final
    # stretch of the run. Comparing the last value to its value entering the
    # final ~40% catches a metric that improved early then froze (which a
    # span-over-the-window test would wrongly call "still moving").
    t_last = node_log[-1]["time_sec"]
    ref_time = 0.6 * t_last
    # The reference must be an EARLIER row, never the last row itself — otherwise
    # when timestamps tie (common: all rows print at 0s) `ref` would equal `last`
    # and every metric compares to itself, falsely reporting "both stalled".
    earlier = [r for r in node_log[:-1] if r["time_sec"] <= ref_time]
    ref = earlier[-1] if earlier else node_log[0]
    last = node_log[-1]

    def _moved(key: str) -> bool:
        scale = max(1.0, abs(last[key]), abs(ref[key]))
        return abs(last[key] - ref[key]) > 1e-6 * scale

    inc_moved = _moved("incumbent")
    bd_moved = _moved("best_bound")

    if bd_moved and not inc_moved:
        return {
            "type": "primal",
            "detail": "The dual bound kept improving but the incumbent was STUCK in the second "
                      "half — this is a primal stall. Push for better feasible solutions.",
            "levers": CATALOG["slow_mip_primal"],
        }
    if inc_moved and not bd_moved:
        return {
            "type": "dual",
            "detail": "The incumbent kept improving but the dual bound was STUCK in the second "
                      "half — this is a dual-bound stall. Push the bound with cuts/MIPFocus 3.",
            "levers": CATALOG["slow_mip_dual"],
        }
    if not inc_moved and not bd_moved:
        return {
            "type": "both",
            "detail": "Both the incumbent and the dual bound STALLED in the second half — the "
                      "search is stuck; attack both sides and consider reformulating.",
            "levers": CATALOG["slow_mip_dual"] + CATALOG["slow_mip_primal"],
        }
    return {
        "type": "progressing",
        "detail": "Both bound and incumbent were still improving at the limit — it likely just "
                  "needs more time (or relax MIPGap if the current gap is acceptable).",
        "levers": [],
    }


def _structure_findings(
    model_info: dict[str, Any], parsed: dict[str, Any], stats: dict[str, list[float]]
) -> list[Finding]:
    """Findings about the model's mathematical class, linearizable constructs,
    and formulation-level size/speed opportunities."""
    out: list[Finding] = []
    if not model_info:
        return out

    mclass = model_info.get("model_class")
    is_linear = model_info.get("is_linear")
    if mclass:
        out.append({
            "id": "model_class",
            "severity": "info",
            "title": f"Model class: {mclass}",
            "detail": (
                "Already a linear program — the fastest class; no linearization needed."
                if is_linear else
                f"This is a {mclass}. Linear/MILP models solve fastest; where the nonlinear or "
                "logical parts have exact linear reformulations, applying them usually speeds "
                "the solve."
            ),
            "levers": [],
        })

    # One finding per distinct general-constraint subtype present.
    for tname, count in (model_info.get("gen_constraints") or {}).items():
        reform = reformulations.GEN_CONSTR.get(tname)
        if reform is None:
            continue
        out.append({
            "id": f"gen_{tname.lower()}",
            "severity": "info",
            "title": f"{count}× {tname} general constraint(s) — {reform['linearizable']}",
            "detail": reform["advice"],
            "levers": [{"parameter": None,
                        "change": f"Reformulate the {count} {tname} constraint(s)",
                        "rationale": reform["advice"]}],
        })

    # Quadratic objective / constraints.
    if model_info.get("n_quad_obj_terms"):
        out.append({
            "id": "quadratic_objective", "severity": "info",
            "title": "Quadratic objective", "detail": reformulations.QUADRATIC["objective"],
            "levers": [{"parameter": None, "change": "Convexify or linearize the quadratic objective",
                        "rationale": reformulations.QUADRATIC["objective"]}],
        })
    if model_info.get("n_quad_constrs"):
        out.append({
            "id": "quadratic_constraints", "severity": "info",
            "title": f"{model_info['n_quad_constrs']} quadratic constraint(s)",
            "detail": reformulations.QUADRATIC["constraint"],
            "levers": [{"parameter": None, "change": "Tighten bounds on bilinear terms; linearize "
                        "binary products exactly", "rationale": reformulations.QUADRATIC["constraint"]}],
        })

    # Dense model → sparsify.
    density = model_info.get("density")
    if density is not None and density > DENSE_FRACTION:
        out.append({
            "id": "dense_model", "severity": "info",
            "title": f"Dense constraint matrix ({density:.0%} nonzero)",
            "detail": "Dense rows make every LP iteration costly. Introduce an aggregate variable "
                      "s = Σ aᵢxᵢ for repeated dense sums.",
            "levers": [{"parameter": "PreSparsify", "change": "1", "set_value": "1",
                        "rationale": "Lets Gurobi rewrite constraints to cut the nonzero count."}],
        })

    # Big-M: prefer the model-based detection (names the constraint + a concrete
    # tighter value); fall back to the bounds/RHS-magnitude signal.
    big_m = model_info.get("big_m_constraints") or []
    if big_m:
        examples = "; ".join(
            f"`{b['constraint']}` (M≈{b['current_M']:g}, but the rest of the row only reaches "
            f"≈{b['reachable_activity']:g})"
            for b in big_m[:3]
        )
        out.append({
            "id": "tight_big_m", "severity": "info",
            "title": f"{len(big_m)} likely-loose big-M constraint(s) detected",
            "detail": (
                f"These rows pair a binary with a coefficient far larger than the rest of the row "
                f"can reach: {examples}. That is a strong sign the big-M is looser than necessary, "
                "which weakens the LP relaxation and adds numerical risk. Recompute the minimal M "
                "valid for each row's logic (it depends on the RHS and which binary value "
                "deactivates the row) and tighten it — or switch to an indicator constraint. "
                "(Heuristic flag — do not blindly set M to the reachable value; verify the logic.)"
            ),
            "levers": [{"parameter": None,
                        "change": "Recompute and tighten each oversized big-M (or use an indicator "
                                  "constraint)",
                        "rationale": "A tight big-M strengthens the relaxation and avoids round-off."}],
        })
    else:
        bnd_hi = (stats.get("bounds") or [0, 0])[1]
        rhs_hi = (stats.get("rhs") or [0, 0])[1]
        if bnd_hi > BIG_M_BOUND or rhs_hi > BIG_M_RHS:
            out.append({
                "id": "loose_big_m", "severity": "info",
                "title": "Large bounds/RHS — possible loose big-M",
                "detail": (
                    f"Largest bound ~{bnd_hi:g}, largest RHS ~{rhs_hi:g}. Loose big-M values weaken "
                    "the LP relaxation and add numerical risk. Tighten them to the smallest valid "
                    "value, or switch the implication to an indicator constraint."
                ),
                "levers": [{"parameter": None,
                            "change": "Tighten big-M to the smallest valid value, or use indicators",
                            "rationale": "A tight big-M gives a stronger relaxation and avoids error."}],
            })

    # Presolve removing a large fraction ⇒ model larger than it needs to be.
    presolve = parsed.get("presolve") or {}
    orig = model_info.get("sizes") or parsed.get("sizes") or {}
    if presolve.get("rows") is not None and orig.get("rows"):
        removed_rows = orig["rows"] - presolve["rows"]
        if orig["rows"] > 0 and removed_rows / orig["rows"] > OVERSIZE_PRESOLVE:
            out.append({
                "id": "oversize", "severity": "info",
                "title": f"Presolve removed {removed_rows / orig['rows']:.0%} of rows",
                "detail": "Presolve is discarding a large share of the model — much of the "
                          "formulation is redundant. Generating a tighter model up front saves "
                          "presolve time and memory.",
                "levers": [],
            })
    return out
