"""
errors.py
─────────
Exceptions raised by the iis_summarization package.
"""

from __future__ import annotations


class IISSummarizationError(Exception):
    """Base class for all errors raised by the package."""


class GurobiUnavailableError(IISSummarizationError):
    """Raised when gurobipy is not importable or no license is available."""


class AnalysisAbortedError(IISSummarizationError):
    """Raised when the pipeline cannot continue (e.g. model is already feasible)."""
