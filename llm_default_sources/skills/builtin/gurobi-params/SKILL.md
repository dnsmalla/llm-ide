---
name: gurobi-params
description: Use when configuring or tuning Gurobi solver parameters — TimeLimit, MIPGap, Threads, IIS computation — e.g. the solver is slow, hits its time limit, or a MIP run must be reproducible
type: domain
stacks: [python]
---

# Skill: Gurobi Parameter Tuning


**When to use**: When creating or tuning Gurobi models for better performance.

**Key Points**:
- Always set LogFile, TimeLimit, MIPGap
- Use 4 threads as default
- Save model formulation (.lp) for debugging
- Check solver status after optimization

## Basic Model Setup

```python
import gurobipy as gp
from gurobipy import GRB

model = gp.Model('grid_optimization')

# Essential parameters
model.setParam('LogFile', 'debug/gurobi.log')
model.setParam('TimeLimit', 3600)     # 1 hour
model.setParam('MIPGap', 0.01)        # 1% optimality gap
model.setParam('Threads', 4)          # Use 4 CPU threads
```

## Performance Parameters

```python
# For faster but less optimal solutions
model.setParam('MIPGap', 0.05)        # 5% gap (faster)
model.setParam('Heuristics', 0.5)     # More heuristics

# For better solutions (slower)
model.setParam('MIPGap', 0.001)       # 0.1% gap (slower)
model.setParam('MIPFocus', 3)         # Focus on optimality
```

## Status Handling

```python
# Optimize
model.optimize()

# Check status
if model.status == GRB.OPTIMAL:
    print(f'Optimal: {model.ObjVal}')
    model.write('debug/solution.sol')
elif model.status == GRB.INFEASIBLE:
    print('Infeasible model')
    model.computeIIS()
    model.write('debug/infeasible.ilp')
elif model.status == GRB.TIME_LIMIT:
    print(f'Time limit, best: {model.ObjVal}')
```

## Debug Files

```python
# Save model formulation
model.write('debug/model.lp')     # Human-readable LP format
model.write('debug/model.mps')    # MPS format for archiving
```

## Common Parameter Combinations

```python
# Quick solve (development)
model.setParam('TimeLimit', 300)      # 5 minutes
model.setParam('MIPGap', 0.05)        # 5%

# Production solve (optimal)
model.setParam('TimeLimit', 7200)     # 2 hours
model.setParam('MIPGap', 0.01)        # 1%
model.setParam('MIPFocus', 3)         # Optimality focus
```

