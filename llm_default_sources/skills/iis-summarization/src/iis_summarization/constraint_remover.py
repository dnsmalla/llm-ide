"""
constraint_remover.py
─────────────────────
Step 3 of the IIS analysis pipeline (legacy heuristic).

Iteratively removes the "heaviest" constraints (those with the most
variable references) from a copy of the base .lp file, testing
feasibility after each batch until the model becomes feasible or
the iteration limit is reached.

The original .lp file is never modified; intermediate copies are
written under ``work_dir``.
"""

from __future__ import annotations

import logging
import re
import shutil
from pathlib import Path

from iis_summarization.feasibility import test_feasibility
from iis_summarization.interfaces import IConstraintRemover
from iis_summarization.models import ParsedILP, RemovalResult

logger = logging.getLogger(__name__)


_SECTION_END_TOKENS = frozenset(
    ["bounds", "binary", "binaries", "general", "generals", "integer", "integers", "end"]
)


class ConstraintRemover(IConstraintRemover):
    """Default implementation of :class:`IConstraintRemover`."""

    @classmethod
    def create(cls) -> IConstraintRemover:
        """Factory returning an :class:`IConstraintRemover`."""
        return cls()

    def run(
        self,
        base_lp_file: Path,
        parsed_ilp: ParsedILP,
        work_dir: Path,
        max_iterations: int,
        batch_fraction: float,
        feasibility_timeout: int,
        already_removed: list[str] | None = None,
        iteration_offset: int = 0,
    ) -> RemovalResult:
        return _iterative_removal_impl(
            base_lp_file=base_lp_file,
            parsed_ilp=parsed_ilp,
            work_dir=work_dir,
            max_iterations=max_iterations,
            batch_fraction=batch_fraction,
            feasibility_timeout=feasibility_timeout,
            already_removed=already_removed,
            iteration_offset=iteration_offset,
        )


def iterative_removal(
    base_lp_file: str | Path,
    parsed_ilp: ParsedILP,
    work_dir: str | Path,
    max_iterations: int = 10,
    batch_fraction: float = 0.10,
    feasibility_timeout: int = 30,
    already_removed: list[str] | None = None,
    iteration_offset: int = 0,
) -> RemovalResult:
    """Functional convenience wrapper around :class:`ConstraintRemover`."""
    return ConstraintRemover.create().run(
        base_lp_file=Path(base_lp_file),
        parsed_ilp=parsed_ilp,
        work_dir=Path(work_dir),
        max_iterations=max_iterations,
        batch_fraction=batch_fraction,
        feasibility_timeout=feasibility_timeout,
        already_removed=already_removed,
        iteration_offset=iteration_offset,
    )


# ─────────────────────────────────────────────────────────────
# LP-file manipulation helpers
# ─────────────────────────────────────────────────────────────


def _build_skip_pattern(names: list[str]) -> re.Pattern[str]:
    """Compile a regex that matches constraint-header lines to skip."""
    escaped = "|".join(re.escape(n) for n in names)
    return re.compile(rf"^\s*({escaped})\s*:", re.IGNORECASE)


def create_modified_lp(
    base_lp_file: str | Path,
    constraints_to_remove: list[str],
    output_file: str | Path,
) -> bool:
    """
    Write *output_file* as a copy of *base_lp_file* with
    *constraints_to_remove* omitted from the constraint section.

    Returns
    -------
    bool
        ``True`` on success, ``False`` on I/O failure.
    """
    base_path = Path(base_lp_file)
    out_path = Path(output_file)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    if not constraints_to_remove:
        shutil.copy2(base_path, out_path)
        return True

    skip_pattern = _build_skip_pattern(constraints_to_remove)
    new_constraint_header = re.compile(r"^\s*\S.*:")

    try:
        lines = base_path.read_text(encoding="utf-8").splitlines(keepends=True)
        output_lines: list[str] = []
        in_constraints = False
        skip_current = False

        for line in lines:
            stripped = line.strip().lower()

            if stripped in ("subject to", "s.t.", "st"):
                in_constraints = True
                skip_current = False
                output_lines.append(line)
                continue

            if stripped in _SECTION_END_TOKENS:
                in_constraints = False
                skip_current = False
                output_lines.append(line)
                continue

            if not in_constraints:
                output_lines.append(line)
                continue

            if skip_pattern.match(line):
                skip_current = True
                continue

            if new_constraint_header.match(line) and not skip_pattern.match(line):
                skip_current = False

            if not skip_current:
                output_lines.append(line)

        out_path.write_text("".join(output_lines), encoding="utf-8")
        return True

    except (OSError, UnicodeDecodeError):
        logger.exception("Failed to create modified LP at %s", out_path)
        return False


def select_removal_batch(
    parsed_ilp: ParsedILP,
    already_removed: list[str],
    batch_fraction: float = 0.10,
) -> list[str]:
    """
    Return the next batch of constraint names to remove.

    Selects the top *batch_fraction* of remaining constraints by
    variable-reference count (descending).
    """
    remaining = {
        name: count
        for name, count in parsed_ilp.variable_refs.items()
        if name not in already_removed
    }
    if not remaining:
        return []

    n = max(1, int(len(remaining) * batch_fraction))
    sorted_names = sorted(remaining, key=lambda k: remaining[k], reverse=True)
    return sorted_names[:n]


def _iterative_removal_impl(
    base_lp_file: Path,
    parsed_ilp: ParsedILP,
    work_dir: Path,
    max_iterations: int,
    batch_fraction: float,
    feasibility_timeout: int,
    already_removed: list[str] | None = None,
    iteration_offset: int = 0,
) -> RemovalResult:
    work_dir.mkdir(parents=True, exist_ok=True)

    removed: list[str] = list(already_removed) if already_removed else []
    base_stem = base_lp_file.stem

    logger.info(
        "Iterative removal: %d IIS constraints, batch=%.0f%%, max_iter=%d%s",
        parsed_ilp.constraint_count,
        batch_fraction * 100,
        max_iterations,
        f" (resuming with {len(removed)} already removed)" if removed else "",
    )

    for i in range(1, max_iterations + 1):
        iteration = i + iteration_offset
        batch = select_removal_batch(parsed_ilp, removed, batch_fraction)

        if not batch:
            return RemovalResult(
                success=False,
                iterations_performed=iteration - 1,
                all_removed_constraints=removed,
                message="No more constraints available to remove.",
            )

        removed.extend(batch)
        logger.info(
            "Iter %2d: removing %d constraint(s) (total removed: %d)",
            iteration,
            len(batch),
            len(removed),
        )

        modified_lp = work_dir / f"{base_stem}_iter_{iteration:02d}.lp"
        ok = create_modified_lp(base_lp_file, removed, modified_lp)
        if not ok:
            logger.warning("Could not write %s — skipping iteration", modified_lp.name)
            continue

        result = test_feasibility(modified_lp, timeout=feasibility_timeout)

        if result.is_feasible:
            logger.info(
                "Feasible at iteration %d (solve_time=%.2fs); culprits in batch %d",
                iteration,
                result.solve_time,
                iteration,
            )
            return RemovalResult(
                success=True,
                iterations_performed=iteration,
                culprit_constraints=batch,
                all_removed_constraints=removed,
                feasible_model_file=modified_lp,
                final_solve_time=result.solve_time,
                message=f"Model became feasible at iteration {iteration}.",
            )
        logger.info("Still infeasible (status=%s)", result.model_status)

    final_iteration = iteration_offset + max_iterations
    return RemovalResult(
        success=False,
        iterations_performed=final_iteration,
        all_removed_constraints=removed,
        message=f"Reached maximum of {final_iteration} iterations without feasibility.",
    )
