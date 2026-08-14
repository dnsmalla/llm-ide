---
name: docstrings
description: Use when writing or reviewing Python functions that lack docstrings, or when asked to add or fix docstrings — Google style (Args/Returns/Raises) per GRID standards
type: domain
stacks: [python]
---

# Skill: Google-Style Docstrings


**When to use**: When functions are missing docstrings or need documentation.

**Key Points**:
- One-line summary first
- Args section for parameters
- Returns section for return value
- Raises section for exceptions
- Include examples for complex functions

## Basic Template

```python
def function_name(param1: str, param2: int) -> bool:
    """
    One-line summary of what the function does.
    
    More detailed explanation if needed. Can span multiple lines
    to explain complex behavior or important notes.
    
    Args:
        param1: Description of first parameter
        param2: Description of second parameter
        
    Returns:
        Description of what is returned
        
    Raises:
        ExceptionType: When this exception is raised
    """
    pass
```

## Examples

### Simple Function
```python
def calculate_total(values: List[float]) -> float:
    """Calculate sum of all values in list."""
    return sum(values)
```

### With Args and Returns
```python
def load_config(config_path: str) -> Dict[str, Any]:
    """
    Load configuration from YAML file.
    
    Args:
        config_path: Path to configuration file
        
    Returns:
        Configuration dictionary with all settings
    """
```

### With Raises
```python
def read_excel(file_path: str) -> pd.DataFrame:
    """
    Read Excel file into DataFrame.
    
    Args:
        file_path: Path to Excel file
        
    Returns:
        DataFrame with file contents
        
    Raises:
        FileNotFoundError: If file doesn't exist
        pd.errors.EmptyDataError: If file is empty
    """
```

### With Example
```python
def format_filename(category: str, version: str) -> str:
    """
    Format output filename following GRID convention.
    
    Args:
        category: File category (e.g., 'KPI', '結果')
        version: Version string (e.g., '01', '02')
        
    Returns:
        Formatted filename with timestamp
        
    Example:
        >>> format_filename('KPI', '01')
        'output_KPI_ver01_20241024153045.xlsx'
    """
```

## Common Patterns

```python
# DataFrame processing
def process_data(df: pd.DataFrame, config: Dict[str, Any]) -> pd.DataFrame:
    """
    Process input data according to configuration.
    
    Applies filtering, transformation, and validation based on
    the configuration settings.
    
    Args:
        df: Input DataFrame to process
        config: Configuration dictionary with processing parameters
        
    Returns:
        Processed DataFrame ready for optimization
    """
```

