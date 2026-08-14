"""
logging_config.py
─────────────────
Centralized logging setup for the iis_summarization package.

The package itself never calls :func:`logging.basicConfig` in its modules.
This helper is provided for the CLI and callers that want a reasonable
default. Library users remain free to install their own handlers.
"""

from __future__ import annotations

import logging
import sys
from typing import TextIO

_DEFAULT_FORMAT = "%(asctime)s  %(levelname)-7s  %(name)s  %(message)s"
_DEFAULT_DATEFMT = "%Y-%m-%d %H:%M:%S"


def configure_logging(
    level: int = logging.INFO,
    stream: TextIO | None = None,
    fmt: str = _DEFAULT_FORMAT,
    datefmt: str = _DEFAULT_DATEFMT,
) -> None:
    """
    Install a single StreamHandler on the ``iis_summarization`` logger.

    Safe to call multiple times: previously installed handlers on the
    package logger are cleared first so repeated invocations do not
    duplicate output.

    Parameters
    ----------
    level
        Logging level applied to the package logger.
    stream
        Stream to write to (defaults to ``sys.stderr``).
    fmt, datefmt
        Standard :mod:`logging` format strings.
    """
    root = logging.getLogger("iis_summarization")

    for handler in list(root.handlers):
        root.removeHandler(handler)

    handler = logging.StreamHandler(stream if stream is not None else sys.stderr)
    handler.setFormatter(logging.Formatter(fmt=fmt, datefmt=datefmt))
    root.addHandler(handler)
    root.setLevel(level)
    root.propagate = False
