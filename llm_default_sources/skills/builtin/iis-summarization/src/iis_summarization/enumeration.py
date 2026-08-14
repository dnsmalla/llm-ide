"""
enumeration.py
──────────────
Iteratively enumerate multiple IISes in a model.

Algorithm
─────────
Standard "remove + recompute" multi-IIS enumeration:

    1. Load the .lp once.
    2. Solve. If feasible → stop (model now has none left).
    3. computeIIS, record the IIS's constraint names, write
       ``<stem>_iis_NN.ilp`` for that iteration.
    4. Remove those constraints from the working model.
    5. Goto 2.

The found list is bounded by ``max_iises`` and a wall-clock
``budget_seconds``. Each iteration's ``computeIIS`` honours
``iis_timeout``.

The output is NOT a guarantee of "all IISes in the original model"
(there may be others that share constraints with already-found ones).
It does prove the model has at least N distinct IISes and exhibits one
representative of each.
"""

from __future__ import annotations

import contextlib
import logging
import time
from collections import Counter, OrderedDict
from dataclasses import dataclass, field
from pathlib import Path

from iis_summarization._gurobi import import_gurobi
from iis_summarization.errors import GurobiUnavailableError
from iis_summarization.ilp_reducer import family_key

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class EnumerationOptions:
    """Caps for the enumeration loop."""

    max_iises: int = 10
    budget_seconds: float = 3600.0
    iis_timeout: int = 300
    feasibility_timeout: int = 60
    relax_instead_of_remove: bool = False
    """Per Gurobi's guidance: removing a found IIS also removes every
    OTHER IIS that shares one of its constraints, hiding overlaps.
    When True, each found IIS constraint's RHS is first loosened by
    ``1e-3 * (1 + |rhs|)``; if the same IIS reappears, exactly ONE
    member is removed (the shared members survive, so overlapping
    IISes can surface). Equality members are always removed — an
    equality cannot be loosened one-sidedly via its RHS."""


@dataclass
class FoundIIS:
    """One IIS found by enumeration."""

    index: int
    constraint_names: list[str] = field(default_factory=list)
    families: Counter[str] = field(default_factory=Counter)
    ilp_file: Path | None = None
    elapsed_seconds: float = 0.0

    @property
    def size(self) -> int:
        return len(self.constraint_names)


@dataclass
class EnumerationResult:
    success: bool
    iises: list[FoundIIS] = field(default_factory=list)
    terminated_reason: str = ""
    elapsed_seconds: float = 0.0
    error_message: str = ""

    @property
    def iis_count(self) -> int:
        return len(self.iises)


def _iteration_cap(opts: EnumerationOptions) -> int:
    """Upper bound for the enumeration loop's range (exclusive).

    In remove mode every iteration yields a distinct IIS, so the cap is
    ``max_iises``. In relax mode a stubborn IIS can recur once after the
    epsilon relaxation (then one member is removed), so each distinct
    IIS may cost up to two iterations — capped with headroom.
    """
    if opts.relax_instead_of_remove:
        return opts.max_iises * 3 + 1
    return opts.max_iises + 1


def _relax_or_remove(
    model: object,
    iis_names: list[str],
    occurrence: int,
    opts: EnumerationOptions,
) -> None:
    """Neutralize the found IIS so the next round finds a different one.

    Remove mode: delete ALL the IIS constraints (fast, but hides any
    other IIS that shares one of them).

    Relax mode (Gurobi's guidance for overlapping IISes), two stages:

    * First sighting — loosen each inequality member's RHS by
      ``1e-3 * (1 + |rhs|)``. A narrow conflict dissolves and every
      member stays alive for overlapping IISes. Equality members are
      removed (an equality cannot be loosened one-sidedly via its RHS).
    * Repeat sighting — the epsilon was not enough; remove exactly ONE
      member (the last-listed). Removing one, not all, is Gurobi's
      documented pattern for discovering overlapping IISes: the shared
      members survive. Once a member is gone this exact IIS cannot
      recur, so the loop always terminates.
    """
    iis_set = set(iis_names)

    if not opts.relax_instead_of_remove:
        for c in list(model.getConstrs()):
            if c.ConstrName in iis_set:
                model.remove(c)
        return

    if occurrence > 1:
        last_member = iis_names[-1]
        for c in list(model.getConstrs()):
            if c.ConstrName == last_member:
                model.remove(c)
                return
        # Defensive: name not found (shouldn't happen) — remove them all
        # rather than risk an endless loop.
        for c in list(model.getConstrs()):
            if c.ConstrName in iis_set:
                model.remove(c)
        return

    for c in list(model.getConstrs()):
        if c.ConstrName not in iis_set:
            continue
        if c.Sense == "<":
            c.RHS = c.RHS + 1e-3 * (1 + abs(c.RHS))
        elif c.Sense == ">":
            c.RHS = c.RHS - 1e-3 * (1 + abs(c.RHS))
        else:
            model.remove(c)


def enumerate_iises(
    lp_file: str | Path,
    output_dir: str | Path,
    options: EnumerationOptions | None = None,
) -> EnumerationResult:
    """Run the enumeration loop and write per-IIS .ilp files + a summary."""
    opts = options or EnumerationOptions()
    lp_path = Path(lp_file)
    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    result = EnumerationResult(success=False)

    try:
        gp, GRB = import_gurobi()
    except GurobiUnavailableError as exc:
        result.error_message = str(exc)
        result.terminated_reason = "gurobi_unavailable"
        return result

    overall_start = time.perf_counter()
    model = None
    try:
        model = gp.read(str(lp_path))
        model.setParam("OutputFlag", 0)
        model.setParam("DualReductions", 0)  # force INFEASIBLE vs UNBOUNDED to disambiguate.

        # Relax-mode bookkeeping: how often each distinct IIS reappeared.
        seen_iis_counts: dict[frozenset[str], int] = {}
        distinct_found = 0

        for iteration in range(1, _iteration_cap(opts)):
            elapsed = time.perf_counter() - overall_start
            if elapsed >= opts.budget_seconds:
                logger.warning(
                    "Enumeration: %ss budget exhausted after %d IIS(es).",
                    opts.budget_seconds,
                    iteration - 1,
                )
                result.terminated_reason = "budget"
                break

            iter_start = time.perf_counter()
            model.setParam("TimeLimit", opts.feasibility_timeout)
            model.optimize()

            if model.status in (GRB.OPTIMAL, GRB.SUBOPTIMAL):
                logger.info(
                    "Enumeration: model is feasible after removing %d IIS(es). Done.",
                    iteration - 1,
                )
                result.terminated_reason = "feasible"
                break
            if model.status == GRB.UNBOUNDED:
                logger.warning(
                    "Enumeration: model became UNBOUNDED after removing %d IIS(es). "
                    "Stopping — remaining infeasibilities can't be enumerated this way.",
                    iteration - 1,
                )
                result.terminated_reason = "unbounded"
                break
            if model.status == GRB.TIME_LIMIT:
                logger.warning(
                    "Enumeration: feasibility solve hit the %ss limit at iteration %d. Stopping.",
                    opts.feasibility_timeout,
                    iteration,
                )
                result.terminated_reason = "timeout"
                break
            if model.status != GRB.INFEASIBLE:
                logger.warning(
                    "Enumeration: unexpected status %d at iteration %d. Stopping.",
                    model.status,
                    iteration,
                )
                result.terminated_reason = f"status_{model.status}"
                break

            model.setParam("TimeLimit", opts.iis_timeout)
            model.computeIIS()
            if model.status == GRB.TIME_LIMIT:
                logger.warning(
                    "Enumeration: computeIIS hit the %ss limit at iteration %d. Stopping.",
                    opts.iis_timeout,
                    iteration,
                )
                result.terminated_reason = "iis_timeout"
                break

            iis_names = [c.ConstrName for c in model.getConstrs() if c.IISConstr]
            iis_key = frozenset(iis_names)
            occurrence = seen_iis_counts.get(iis_key, 0) + 1
            seen_iis_counts[iis_key] = occurrence

            if occurrence == 1:
                distinct_found += 1
                families: Counter[str] = Counter(family_key(n) for n in iis_names)
                ilp_path = out_dir / f"{lp_path.stem}_iis_{distinct_found:02d}.ilp"
                model.write(str(ilp_path))

                found = FoundIIS(
                    index=distinct_found,
                    constraint_names=iis_names,
                    families=families,
                    ilp_file=ilp_path,
                    elapsed_seconds=time.perf_counter() - iter_start,
                )
                result.iises.append(found)
                logger.info(
                    "Enumeration: IIS #%d found (%d constraints, %d families) in %.1fs -> %s",
                    distinct_found,
                    found.size,
                    len(families),
                    found.elapsed_seconds,
                    ilp_path.name,
                )
                if distinct_found >= opts.max_iises:
                    logger.info(
                        "Enumeration: reached --max-iises=%d cap. "
                        "Model may still be infeasible.",
                        opts.max_iises,
                    )
                    result.terminated_reason = "max_iises"
                    break

            # Loosen or remove the found IIS so the next iteration sees a
            # *different* one. Relax mode (Gurobi's recommendation) keeps
            # shared constraints alive so overlapping IISes can surface.
            _relax_or_remove(model, iis_names, occurrence, opts)
            model.update()

        else:
            # Iteration cap exhausted without becoming feasible.
            logger.info(
                "Enumeration: iteration cap reached with %d distinct IIS(es). "
                "Model may still be infeasible.",
                distinct_found,
            )
            result.terminated_reason = "max_iises"

        result.success = True
        result.elapsed_seconds = time.perf_counter() - overall_start
        return result

    except gp.GurobiError as exc:
        logger.exception("Gurobi error during IIS enumeration")
        result.error_message = f"Gurobi error: {exc}"
        result.terminated_reason = "error"
        result.elapsed_seconds = time.perf_counter() - overall_start
        return result
    except (FileNotFoundError, OSError) as exc:
        logger.exception("I/O error during IIS enumeration")
        result.error_message = f"I/O error: {exc}"
        result.terminated_reason = "error"
        result.elapsed_seconds = time.perf_counter() - overall_start
        return result
    finally:
        if model is not None:
            with contextlib.suppress(AttributeError, gp.GurobiError):
                model.dispose()


def write_enumeration_summary(
    result: EnumerationResult,
    lp_file: Path,
    output_dir: Path,
    language: str = "en",
) -> Path:
    """Render a Markdown summary of an enumeration result.

    *language* (``"en"`` / ``"ja"``) localizes headers, labels, and the
    termination reason; constraint-name templates and numbers stay
    verbatim.
    """
    from iis_summarization.i18n import enum_reason_label, tr

    out_path = output_dir / f"{lp_file.stem}_iis_enumeration.md"

    lines: list[str] = [
        "# " + tr(language, "enum_title"),
        "",
        f"> **{tr(language, 'enum_model')}:** `{lp_file}`",
        f"> **{tr(language, 'enum_found')}:** {result.iis_count}",
        f"> **{tr(language, 'enum_terminated')}:** "
        f"{enum_reason_label(language, result.terminated_reason)}",
        f"> **{tr(language, 'enum_elapsed')}:** {result.elapsed_seconds:.1f} s",
        "",
        "---",
        "",
    ]

    if result.iis_count == 0:
        if result.terminated_reason == "feasible":
            lines.append(tr(language, "enum_feasible"))
        elif result.error_message:
            lines.append(tr(language, "enum_failed", error=result.error_message))
        else:
            lines.append(tr(language, "enum_none"))
        lines.append("")
        out_path.write_text("\n".join(lines), encoding="utf-8")
        return out_path

    lines.append("## " + tr(language, "enum_per_iis"))
    lines.append("")
    lines.append(tr(language, "enum_table_header"))
    lines.append("|---|---|---|---|---|")
    for f in result.iises:
        family_summary = ", ".join(
            f"`{name}`×{count}" for name, count in f.families.most_common(3)
        )
        if len(f.families) > 3:
            family_summary += ", " + tr(language, "enum_more", n=len(f.families) - 3)
        file_label = f.ilp_file.name if f.ilp_file else "—"
        lines.append(
            f"| {f.index} | {f.size} | {family_summary} | {f.elapsed_seconds:.1f}s | "
            f"`{file_label}` |"
        )
    lines.append("")

    # Cross-IIS template aggregation — surfaces the "same template, many
    # slots" pattern that is the most common reason for multiple IISes.
    template_to_indices: OrderedDict[str, list[int]] = OrderedDict()
    for f in result.iises:
        for template in f.families:
            template_to_indices.setdefault(template, []).append(f.index)

    if template_to_indices:
        lines.append("## " + tr(language, "enum_cross_title"))
        lines.append("")
        lines.append(tr(language, "enum_cross_intro"))
        lines.append("")
        lines.append(tr(language, "enum_cross_header"))
        lines.append("|---|---|---|")
        sorted_templates = sorted(
            template_to_indices.items(), key=lambda kv: -len(kv[1])
        )
        for template, indices in sorted_templates:
            indices_repr = ", ".join(str(i) for i in indices[:20])
            if len(indices) > 20:
                indices_repr += ", " + tr(language, "enum_more", n=len(indices) - 20)
            lines.append(f"| `{template}` | {len(indices)} | {indices_repr} |")
        lines.append("")

    lines.append("---")
    lines.append("")
    lines.append(tr(language, "enum_footer"))
    lines.append("")

    out_path.write_text("\n".join(lines), encoding="utf-8")
    return out_path
