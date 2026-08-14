"""
interfaces.py
─────────────
Abstract base classes for the IIS analysis pipeline.

Every non-dataclass, non-factory class in this package implements one of
these interfaces. Callers should type their arguments and return values
against these interfaces, not the concrete implementations
(see project design rule #2).
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any

from iis_summarization.models import (
    BatchRefinementResult,
    ClassificationResult,
    DeletionFilterResult,
    FeasibilityResult,
    IISRunResult,
    PropagationTrace,
    ParsedILP,
    RelaxationResult,
    RemovalResult,
    SemanticGroupResult,
)


class IIISRunner(ABC):
    """Runs Gurobi's computeIIS on an infeasible LP and emits the .ilp file."""

    @abstractmethod
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
        """Load *lp_file*, confirm it is infeasible, then call computeIIS().

        *iis_method* / *numeric_focus* / *threads* map to Gurobi's
        ``IISMethod``, ``NumericFocus``, and ``Threads`` parameters;
        ``None`` keeps Gurobi defaults. *iis_target* enables the
        callback-based early exit (terminate once the IIS-size upper
        bound reaches the target).
        """


class IILPParser(ABC):
    """Parses a Gurobi .ilp file into a structured :class:`ParsedILP`."""

    @abstractmethod
    def parse(self, ilp_file: Path) -> ParsedILP:
        """Return structured constraint/bound data parsed from *ilp_file*."""


class IConstraintRemover(ABC):
    """Iteratively removes constraint batches until feasibility is reached."""

    @abstractmethod
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
        """Run iterative removal and return a :class:`RemovalResult`.

        When *already_removed* is supplied, those constraint names are treated
        as having been stripped before iteration 1 — the new call resumes
        instead of restarting from scratch.

        *iteration_offset* shifts the iteration counter so that resumed runs
        produce unique per-iteration filenames (e.g. start at 11 when the
        previous attempt wrote 01–10).
        """


class IBatchRefiner(ABC):
    """Isolates the single root-cause constraint from a feasible-making batch
    by re-adding each removed constraint one at a time."""

    @abstractmethod
    def refine(
        self,
        base_lp_file: Path,
        batch: list[str],
        parsed_ilp: ParsedILP,
        work_dir: Path,
        feasibility_timeout: int,
    ) -> BatchRefinementResult:
        """Add *batch* constraints back one-by-one; return the root cause."""


class IDeletionFilter(ABC):
    """Applies Chinneck's deletion filter to shrink an IIS to a minimal set."""

    @abstractmethod
    def minimize(
        self,
        lp_file: Path,
        iis_constraint_names: list[str],
        feasibility_timeout: int,
        target_size: int | None = None,
        budget_seconds: float | None = None,
    ) -> DeletionFilterResult:
        """Return a (partial) minimal IIS (Chinneck 1991).

        *target_size* and *budget_seconds* provide early-exit conditions
        so the filter never runs for more iterations than the caller is
        willing to spend: stop as soon as the surviving IIS size ≤
        *target_size*, or as soon as wall-clock elapsed ≥
        *budget_seconds*.
        """


class IClassifier(ABC):
    """Classifies each IIS constraint as a DATA or STRUCTURE problem."""

    @abstractmethod
    def classify(
        self,
        lp_file: Path,
        iis_constraint_names: list[str],
        model: Any | None = None,
    ) -> ClassificationResult:
        """Return classification per constraint.

        When *model* is a pre-loaded gurobipy ``Model``, the
        implementation skips ``gp.read(lp_file)`` and uses it directly
        (read-only). This lets the orchestrator share one parsed model
        across Steps 5, 6, and 7 instead of paying the 90 MB LP parse
        three times.
        """


class ISemanticGrouper(ABC):
    """Partitions an IIS into conflict subsystems connected by shared variables."""

    @abstractmethod
    def group(
        self,
        lp_file: Path,
        iis_constraint_names: list[str],
        model: Any | None = None,
    ) -> SemanticGroupResult:
        """Return connected-component grouping of *iis_constraint_names*.

        When *model* is provided (a pre-loaded gurobipy ``Model``), the
        implementation reuses it instead of re-parsing *lp_file*.
        """


class IFeasibilityTester(ABC):
    """Tests whether an LP file is feasible within a time budget."""

    @abstractmethod
    def test(self, lp_file: Path, timeout: int) -> FeasibilityResult:
        """Optimize *lp_file* with a time limit and return feasibility status."""


class IRelaxer(ABC):
    """Computes minimum numeric adjustments per constraint/bound via feasRelax."""

    @abstractmethod
    def compute(
        self,
        lp_file: Path,
        constraint_names: list[str] | None,
        timeout: int,
        bound_variable_names: list[str] | None = None,
    ) -> RelaxationResult:
        """Solve the L1 feasRelax relaxation.

        Penalties of 1.0 are assigned to constraints in *constraint_names*
        and to variable bounds of *bound_variable_names*; all others are
        penalised 0.0 (meaning "must not be relaxed"). When
        *bound_variable_names* is ``None``, variable bounds are not relaxed.
        """


class ILargeModelFilter(ABC):
    """5-phase fast filter for large IIS sets (200+ constraints).

    Reduces solver calls from O(N) to O(k·log(n/k)) by applying
    rule-based pre-filtering, Farkas dual extraction, elastic filter,
    and QuickXplain divide-and-conquer in sequence.
    """

    @abstractmethod
    def minimize(
        self,
        lp_file: Path,
        iis_constraint_names: list[str],
        feasibility_timeout: int,
        budget_seconds: float | None = None,
    ) -> DeletionFilterResult:
        """Return a minimal IIS using the fast multi-phase pipeline.

        Returns the same :class:`DeletionFilterResult` contract as
        :meth:`IDeletionFilter.minimize` so the rest of the pipeline is
        unchanged.  The result will have ``large_model_pipeline_used=True``
        and ``phases_run`` populated with the names of phases that ran.
        """


class IPropagator(ABC):
    """Step 5.5 — feasibility-based bound tightening over a small IIS.

    Follows the chain of forced variable implications (binaries pinned
    by big-M terms, equalities, bound tightening) to a fixed point and
    reports the exact numeric contradiction when one is reached.
    """

    @classmethod
    @abstractmethod
    def create(cls) -> IPropagator:
        """Factory returning an :class:`IPropagator`."""

    @abstractmethod
    def trace(
        self,
        lp_file: Path,
        iis_constraint_names: list[str],
        model: Any | None = None,
        language: str = "en",
    ) -> PropagationTrace:
        """Return the forced-implication trace for *iis_constraint_names*.

        When *model* is a pre-loaded gurobipy ``Model`` it is reused
        (read-only); the human-readable step text is rendered in
        *language*.
        """


class IReportGenerator(ABC):
    """Renders the final Markdown infeasibility report."""

    @abstractmethod
    def generate(
        self,
        lp_file: Path,
        parsed_ilp: ParsedILP,
        removal_result: RemovalResult,
        relaxation_result: RelaxationResult | None,
        classification_result: ClassificationResult | None,
        grouping_result: SemanticGroupResult | None,
        output_dir: Path,
        refinement_result: BatchRefinementResult | None = None,
        iis_result: IISRunResult | None = None,
        language: str = "en",
        propagation_result: PropagationTrace | None = None,
    ) -> Path:
        """Write a Markdown report and return its path.

        *language* (``"en"`` / ``"ja"``) localizes the Python-written
        headers and labels; names and numbers stay verbatim.
        """
