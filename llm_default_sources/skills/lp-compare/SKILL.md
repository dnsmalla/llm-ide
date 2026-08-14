---
name: lp-compare
description: >-
  Compare two LP (Linear Programming) files to find differences in objectives
  and constraints. Trigger on: "compare these LP files", "diff the LP", "what
  changed between these .lp files", "check if LP files match", "find differences
  in LP", "comparing optimization model formulations", "debug vs correct LP
  outputs", "verifying LP file correctness", or "constraint/objective
  differences between solver runs". Direct trigger: user says "compare LP" and
  provides two .lp paths — use immediately, no clarifying questions.
---

# LP File Comparator

Compare two LP (Linear Programming) files and produce a structured summary of every difference — in objectives, constraints (including SOS/piecewise), and variable presence.

## Quick path — the common case

Most of the time, the user just says something like "compare LP" and gives two file paths. When that happens, don't ask questions — just run the script immediately using the filenames as labels:

```bash
python <skill-path>/scripts/lp_comparator.py /path/to/first.lp /path/to/second.lp
```

The script automatically uses each file's name as its label in the output table. No `--label1`/`--label2` flags needed unless the user explicitly asks for custom labels.

## Large index-heavy models — use `--group-families`

Pyomo / Gurobi LP files emit one constraint **per index** (`pump_v_qw_cal_hp(0_0)`, `(0_1)`, …). A plain name-by-name diff of two such models returns thousands of near-duplicate rows — unreadable. For these, add `--group-families`: it collapses the index part of each name into a **family** and compares **per-family counts** between the two files.

```bash
# Structural diff by constraint family (counts per file + status)
python <skill-path>/scripts/lp_comparator.py simple.lp strict.lp \
  --label1 simple --label2 strict --group-families

# Restrict to a subset of families (case-insensitive regex on the family name)
python <skill-path>/scripts/lp_comparator.py simple.lp strict.lp \
  --group-families --filter 'pump|_hp'
```

Output is a table / CSV with columns `constraint_family, <file1> (file1), <file2> (file2), diff(file2-file1), status`, where **status** is one of `only_in_file1`, `only_in_file2`, `count_differs`, `same` (differences sorted first). CSV auto-saves next to file1 as `lp_family_comparison.csv` (or pass `--csv PATH`).

What it collapses: parenthesised indices `(0_1)`, time indices `_t10_`, and underscore-delimited indices (`_16_`, trailing `_8`). What it **keeps** (so distinct constraint *types* stay distinct): numbers fused to a word — `bigm1` vs `bigm2`, `com1`/`com2`, `gen1`, `LEVEL4`.

**Use the default (name-by-name) mode** when you need to see *content* differences (changed RHS/coefficients on shared constraints). **Use `--group-families`** when you need the structural "which constraint families were added/removed/changed in count" picture — the common case for comparing two formulations of the same model (e.g. a `simple` vs `strict` step).

## How it works

The bundled script at `scripts/lp_comparator.py`:

1. **Parses** each LP file into objective function and named constraints
2. **Normalizes** terms (coefficient formatting, variable naming, sort order) so cosmetic differences don't trigger false positives
3. **Compares** objectives term-by-term and constraints by name, with special handling for SOS2/piecewise constraints
4. **Outputs** a summary table of every difference, categorized by section (Objective / Constraints) and type (Different Value, In File 1 Only, In File 2 Only)

## CLI usage

```bash
# Basic — just two paths, filenames become labels automatically
python <skill-path>/scripts/lp_comparator.py file1.lp file2.lp

# Custom labels
python <skill-path>/scripts/lp_comparator.py file1.lp file2.lp --label1 "debug" --label2 "correct"

# JSON output instead of table
python <skill-path>/scripts/lp_comparator.py file1.lp file2.lp --json

# Custom CSV export path
python <skill-path>/scripts/lp_comparator.py file1.lp file2.lp --csv /path/to/output.csv

# Family-level comparison for large indexed models (see section above)
python <skill-path>/scripts/lp_comparator.py file1.lp file2.lp --group-families [--filter 'pump|_hp']
```

## Presenting results

- **Identical files**: report clearly in one line — no table needed.
- **Differences found**: show the output table directly. The most critical findings are constraints present in only one file — call those out.
- In the default (name-by-name) mode an Excel file is auto-saved next to the first file as `lp_comparison_result.xlsx` (pass `--csv PATH` for CSV instead). In `--group-families` mode a CSV is auto-saved as `lp_family_comparison.csv`.

## Interpreting common patterns

- **Missing constraints**: a constraint in one file but not the other usually means a modeling bug or feature toggle difference
- **SOS/piecewise differences**: coefficient or RHS changes in SOS2 constraints indicate different breakpoint configurations
- **Objective differences**: coefficient changes affect optimization direction; missing terms mean a variable isn't being optimized

## Edge cases

- Different objective senses (Minimize vs Maximize) are detected and reported
- SOS2 and piecewise constraints get special parsing — individual weight/breakpoint values are compared, not raw text
- Term normalization handles whitespace, underscore, and parenthesis formatting differences

## Dependencies

Python 3.8+ with `pandas`. Falls back to text/JSON summary if pandas is missing.
