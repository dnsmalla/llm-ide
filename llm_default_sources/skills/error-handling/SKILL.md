---
name: error-handling
description: Use when adding or reviewing Python error handling — choosing specific exception types, logging failures, avoiding bare except — per GRID standards
type: domain
stacks: [python]
---

# Skill: Error Handling Pattern (GRID Standard)


**When to use**: When adding error handling to functions that do file I/O or external operations.

**Key Points**:
- Use specific exceptions, never bare `except:`
- Use logging, never `print()`
- Always include context in error messages
- Raise exceptions after logging

## Basic Pattern

```python
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

def process_file(file_path: str) -> pd.DataFrame:
    """Process input file with error handling."""
    try:
        path = Path(file_path)
        if not path.exists():
            raise FileNotFoundError(f"File not found: {file_path}")
        
        df = pd.read_excel(file_path)
        logger.info(f"Processed {len(df)} rows from {file_path}")
        return df
        
    except FileNotFoundError:
        logger.error(f"File not found: {file_path}")
        raise
    except pd.errors.EmptyDataError:
        logger.error(f"Empty data in file: {file_path}")
        raise
    except Exception as e:
        logger.error(f"Unexpected error processing {file_path}: {e}")
        raise
```

## Multiple Operations

```python
def run_optimization(config: dict) -> dict:
    """Run optimization with comprehensive error handling."""
    try:
        # Step 1
        logger.info("Loading input data...")
        data = load_input(config['input_file'])
        
        # Step 2
        logger.info("Building model...")
        model = build_model(data, config)
        
        # Step 3
        logger.info("Solving...")
        results = solve_model(model)
        
        logger.info("Optimization completed successfully")
        return results
        
    except FileNotFoundError as e:
        logger.error(f"Input file error: {e}")
        raise
    except ValueError as e:
        logger.error(f"Configuration error: {e}")
        raise
    except Exception as e:
        logger.error(f"Optimization failed: {e}")
        raise
```

## Common Exceptions

- `FileNotFoundError` - File doesn't exist
- `pd.errors.EmptyDataError` - Empty CSV/Excel
- `yaml.YAMLError` - Invalid YAML
- `ValueError` - Invalid values
- `KeyError` - Missing dict key
- `GurobiError` - Gurobi solver error

