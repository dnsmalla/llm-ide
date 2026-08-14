# LP File Format Reference

LP (Linear Programming) files define optimization problems in a human-readable text format used by solvers like CPLEX, Gurobi, and GLPK.

## Structure

```
Minimize (or Maximize)
  obj: 2 x1 + 3 x2 - 1.5 x3

Subject To
  constraint1: x1 + x2 <= 10
  constraint2: 2 x1 - x3 >= 5
  energy_balance: x1 + x2 + x3 = 100

Bounds
  0 <= x1 <= 50
  x2 >= 0

Binary
  y1 y2

Integer
  z1

End
```

## Sections

| Section | Purpose |
|---------|---------|
| `Minimize` / `Maximize` | Objective sense + objective function |
| `Subject To` (or `s.t.`) | Named constraints with operators `<=`, `>=`, `=` |
| `Bounds` | Variable bound declarations |
| `Binary` | 0-1 decision variables |
| `Integer` / `Generals` | Integer-valued variables |
| `SOS` | Special Ordered Set constraints (SOS1/SOS2) |
| `End` | File terminator |

## Constraint naming

Each constraint has a name followed by a colon, then the linear expression:
```
my_constraint_name: 2 x1 + 3 x2 <= 10
```

Multi-line constraints continue on subsequent lines until a blank line or new constraint name.

## SOS2 constraints

SOS2 (Special Ordered Set Type 2) constraints enforce that at most two adjacent variables in an ordered set can be nonzero. They appear in piecewise-linear approximations:

```
SOS2
  sos_set1: x1:1 x2:2 x3:3 x4:4
```

The comparator parses SOS2 weight values and piecewise RHS values separately for precise comparison.

## Common difference patterns

| Pattern | Likely cause |
|---------|-------------|
| Constraint in file 1 only | Feature/toggle enabled in one model but not the other |
| Constraint in file 2 only | Missing constraint in the debug formulation |
| Different coefficient | Parameter or data difference between runs |
| Different RHS | Changed bound or resource limit |
| SOS2 weight difference | Different breakpoint configuration for piecewise linearization |
