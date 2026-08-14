"""
conftest.py
───────────
Pytest configuration for the iis_summarization test suite.

Adds ``src/`` and ``tests/`` to ``sys.path`` so the package and the shared
``tests._helpers`` module are importable without requiring
``pip install -e .``.
"""

from __future__ import annotations

import sys
from pathlib import Path

SKILL_ROOT = Path(__file__).parent.parent
SRC_DIR = SKILL_ROOT / "src"
TESTS_DIR = Path(__file__).parent

for path in (SRC_DIR, TESTS_DIR):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))
