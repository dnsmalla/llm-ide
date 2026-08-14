\ Synthetic production scheduling model — infeasible
\ Worker hours exceed available capacity while meeting all shift requirements
Minimize
  total_cost: 10 w1 + 12 w2 + 15 w3 + 8 w4
Subject To
  shift_morning:   w1 + w2 >= 20
  shift_afternoon: w2 + w3 >= 18
  shift_night:     w3 + w4 >= 15
  capacity_total:  w1 + w2 + w3 + w4 <= 30
  max_w1: w1 <= 8
  max_w2: w2 <= 8
  max_w3: w3 <= 8
  max_w4: w4 <= 6
  budget_limit: 10 w1 + 12 w2 + 15 w3 + 8 w4 <= 200
Bounds
  0 <= w1 <= 8
  0 <= w2 <= 8
  0 <= w3 <= 8
  0 <= w4 <= 6
End
