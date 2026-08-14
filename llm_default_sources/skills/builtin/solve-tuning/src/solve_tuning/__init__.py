"""Solve-tuning engine: explain a Gurobi solver log and recommend changes.

A Python engine parses a raw Gurobi log (no solver needed), assesses solver
health (numerical conditioning, optimality, performance), maps findings to
concrete parameter / formulation levers, and emits a compact ``facts.json``
sized for an LLM summarizer subagent plus a Markdown report.
"""

__version__ = "0.1.0"

from .analyzer import run_analysis

__all__ = ["run_analysis", "__version__"]
