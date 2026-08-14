\ Synthetic infeasible MIP — LP relaxation is already infeasible.
\ Same conflict as tiny_infeasible.lp but x, y are integers.
Minimize
  obj: x + y
Subject To
  demand_min: x + y >= 10
  capacity_max: x + y <= 5
Bounds
  0 <= x <= 100
  0 <= y <= 100
Generals
  x y
End
