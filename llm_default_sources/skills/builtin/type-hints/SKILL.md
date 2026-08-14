---
name: type-hints
description: Use when adding type hints to Python function signatures or fixing mypy/type-check errors, per GRID standards
type: domain
stacks: [python]
---

# Skill: Add Type Hints (GRID Mandatory)


**When to use**: When functions are missing type hints (GRID requirement).

**Key Points**:
- All function parameters must have type hints
- All return values must have type hints
- Use `from typing import` for complex types
- Use `-> None` for functions with no return

## Basic Types

```python
from typing import Dict, List, Optional, Any
from pathlib import Path
import pandas as pd

# Simple types
def calculate_total(value: float, rate: float) -> float:
    return value * rate

# String, int, bool
def process_file(file_path: str, max_rows: int = 100, validate: bool = True) -> bool:
    pass

# None return
def log_message(message: str) -> None:
    print(message)
```

## Complex Types

```python
# Dict
def load_config(path: str) -> Dict[str, Any]:
    return {'key': 'value'}

# List
def get_file_list(directory: str) -> List[Path]:
    return [Path('file1.txt'), Path('file2.txt')]

# Optional (can be None)
def find_file(name: str) -> Optional[Path]:
    return Path(name) if exists else None

# Multiple return values (Tuple)
from typing import Tuple
def process_data(df: pd.DataFrame) -> Tuple[pd.DataFrame, int]:
    return df, len(df)
```

## Pandas Types

```python
def load_excel(path: str) -> pd.DataFrame:
    return pd.read_excel(path)

def summarize(df: pd.DataFrame) -> pd.Series:
    return df.sum()
```

## Complex Return Types

```python
# Dict with specific structure
def get_results() -> Dict[str, pd.DataFrame]:
    return {'kpi': df1, 'summary': df2}

# List of dicts
def get_records() -> List[Dict[str, Any]]:
    return [{'id': 1, 'name': 'test'}]
```

## Common GRID Types

```python
# Config loading
def load_config(config_path: str) -> Dict[str, Any]:
    pass

# DataFrame processing
def process_data(df: pd.DataFrame, config: Dict[str, Any]) -> pd.DataFrame:
    pass

# File paths
def get_output_path(base_dir: str, filename: str) -> Path:
    return Path(base_dir) / filename
```

