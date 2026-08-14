"""
batch_refiner.py
────────────────
Step 3.5 of the IIS analysis pipeline.

Given a constraint batch that — when removed from the base .lp — made the
model feasible, this step isolates the single *root cause* constraint
inside the batch by re-adding constraints one at a time.

Algorithm
─────────
1. Sort the batch by variable-reference count (descending) so the
   densest constraint is probed first.
2. Start from the feasible LP (all batch constraints removed).
3. For each constraint ``c`` in order:
     - Re-introduce ``c`` (write an LP with only the remaining batch
       constraints stripped from the original base .lp).
     - Test feasibility.
     - If infeasible → ``c`` is the root cause; stop.
4. If every add-back kept the model feasible, there is no single root
   cause; the batch is a *joint culprit* set — report it as such.

The original .lp file is never modified.
"""

from __future__ import annotations

import logging
import time
from pathlib import Path

from iis_summarization.constraint_remover import create_modified_lp
from iis_summarization.feasibility import test_feasibility
from iis_summarization.interfaces import IBatchRefiner
from iis_summarization.models import (
    AddBackStep,
    BatchRefinementResult,
    ParsedILP,
)

logger = logging.getLogger(__name__)


class BatchRefiner(IBatchRefiner):
    """Default implementation of :class:`IBatchRefiner`."""

    @classmethod
    def create(cls) -> IBatchRefiner:
        """Factory returning an :class:`IBatchRefiner`."""
        return cls()

    def refine(
        self,
        base_lp_file: Path,
        batch: list[str],
        parsed_ilp: ParsedILP,
        work_dir: Path,
        feasibility_timeout: int,
    ) -> BatchRefinementResult:
        return _refine_batch_impl(
            base_lp_file=base_lp_file,
            batch=batch,
            parsed_ilp=parsed_ilp,
            work_dir=work_dir,
            feasibility_timeout=feasibility_timeout,
        )


def refine_batch(
    base_lp_file: str | Path,
    batch: list[str],
    parsed_ilp: ParsedILP,
    work_dir: str | Path,
    feasibility_timeout: int = 30,
) -> BatchRefinementResult:
    """Functional convenience wrapper around :class:`BatchRefiner`."""
    return BatchRefiner.create().refine(
        base_lp_file=Path(base_lp_file),
        batch=list(batch),
        parsed_ilp=parsed_ilp,
        work_dir=Path(work_dir),
        feasibility_timeout=feasibility_timeout,
    )


def _order_batch(batch: list[str], parsed_ilp: ParsedILP) -> list[str]:
    """Return *batch* sorted by variable-reference count (descending)."""
    return sorted(batch, key=lambda name: parsed_ilp.variable_refs.get(name, 0), reverse=True)


def _refine_batch_impl(
    base_lp_file: Path,
    batch: list[str],
    parsed_ilp: ParsedILP,
    work_dir: Path,
    feasibility_timeout: int,
) -> BatchRefinementResult:
    start = time.perf_counter()

    if not batch:
        return BatchRefinementResult(
            success=False,
            error_message="Empty batch — nothing to refine.",
            elapsed_seconds=time.perf_counter() - start,
        )

    if len(batch) == 1:
        logger.info("Batch has a single constraint — already minimal: %s", batch[0])
        return BatchRefinementResult(
            success=True,
            root_cause=batch[0],
            add_back_trace=[],
            elapsed_seconds=time.perf_counter() - start,
        )

    work_dir.mkdir(parents=True, exist_ok=True)
    ordered = _order_batch(batch, parsed_ilp)
    logger.info(
        "Refinement: adding %d constraint(s) back one-by-one (order by var refs)",
        len(ordered),
    )

    added_back: set[str] = set()
    trace: list[AddBackStep] = []
    base_stem = base_lp_file.stem

    for i, c in enumerate(ordered, 1):
        added_back.add(c)
        still_removed = [name for name in batch if name not in added_back]
        probe_lp = work_dir / f"{base_stem}_addback_{i:02d}.lp"
        ok = create_modified_lp(base_lp_file, still_removed, probe_lp)
        if not ok:
            logger.warning("Could not write %s — aborting refinement", probe_lp.name)
            return BatchRefinementResult(
                success=False,
                add_back_trace=trace,
                error_message=f"Failed to write probe LP: {probe_lp}",
                elapsed_seconds=time.perf_counter() - start,
            )

        result = test_feasibility(probe_lp, timeout=feasibility_timeout)
        trace.append(
            AddBackStep(
                constraint_name=c,
                is_feasible=result.is_feasible,
                solve_time=result.solve_time,
            )
        )
        logger.info(
            "Add-back %2d/%d: %s -> %s (solve=%.2fs)",
            i,
            len(ordered),
            c,
            "feasible" if result.is_feasible else "INFEASIBLE",
            result.solve_time,
        )

        if not result.is_feasible:
            return BatchRefinementResult(
                success=True,
                root_cause=c,
                add_back_trace=trace,
                elapsed_seconds=time.perf_counter() - start,
            )

    logger.info(
        "No single add-back caused infeasibility — batch of %d is a joint culprit.",
        len(batch),
    )
    return BatchRefinementResult(
        success=True,
        root_cause=None,
        joint_culprits=list(ordered),
        add_back_trace=trace,
        elapsed_seconds=time.perf_counter() - start,
    )
