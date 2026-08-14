---
name: excel-io
description: Use when reading or writing Excel files from Python (pandas + openpyxl), especially with Japanese text or encodings (UTF-8, CP932) or multi-sheet workbooks
type: domain
stacks: [python]
---

# Skill: Excel File I/O (Japanese Support)


**When to use**: When working with Excel files that contain Japanese text or need timestamp-based filenames.

**Key Points**:
- Use `openpyxl` engine for Excel
- Use `encoding='utf-8-sig'` for CSV with Japanese
- Add timestamps to output filenames
- Check file existence before reading

## Reading Excel Files

```python
import pandas as pd
from pathlib import Path

# Basic read
df = pd.read_excel('input.xlsx', sheet_name='シート1')

# Check existence first
path = Path('input.xlsx')
if path.exists():
    df = pd.read_excel(path)
```

## Writing Excel Files with Timestamp

```python
from datetime import datetime
from pathlib import Path

# Create timestamped filename
timestamp = datetime.now().strftime('%Y%m%d%H%M%S')
filename = f"output_KPI_ver01_{timestamp}.xlsx"

# Write to Excel
output_dir = Path('output')
output_dir.mkdir(parents=True, exist_ok=True)
output_path = output_dir / filename

df.to_excel(output_path, sheet_name='結果', index=False)
```

## Multiple Sheets

```python
# Write multiple sheets
with pd.ExcelWriter('output.xlsx', engine='openpyxl') as writer:
    df1.to_excel(writer, sheet_name='KPI', index=False)
    df2.to_excel(writer, sheet_name='結果', index=False)
```

## CSV with Japanese

```python
# Write CSV with Japanese support
df.to_csv('output.csv', index=False, encoding='utf-8-sig')

# Read CSV with Japanese
df = pd.read_csv('input.csv', encoding='utf-8-sig')
```

## GRID File Naming Convention

```
Input:  input_<category>_<type>_ver<version>_<date>.xlsx
Output: output_<category>_<type>_ver<version>_<case>_<timestamp>.xlsx
Example: output_KPI・サマリ_ver01_case1_20241024153045.xlsx
```

