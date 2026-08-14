\ Synthetic infeasible model — used by test suite (no real data)
\ x + y must be >= 10  AND  <= 5 simultaneously → impossible
Minimize
  obj: x + y
Subject To
  demand_min: x + y >= 10
  capacity_max: x + y <= 5
  non_negative_x: x >= 0
  non_negative_y: y >= 0
Bounds
  0 <= x <= 100
  0 <= y <= 100
End
