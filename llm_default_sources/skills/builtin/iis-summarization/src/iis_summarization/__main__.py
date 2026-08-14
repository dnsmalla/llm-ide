"""Enable ``python -m iis_summarization``."""

from __future__ import annotations

import sys

from iis_summarization.cli import main

if __name__ == "__main__":
    sys.exit(main())
