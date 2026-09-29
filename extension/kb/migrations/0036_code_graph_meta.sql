-- Which commit a repo's code graph was generated from. Without it the server
-- could not tell the model that line numbers and symbols may be out of date.
CREATE TABLE IF NOT EXISTS code_graph_meta (
  user_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  commit_sha TEXT,
  generated_at TEXT,
  PRIMARY KEY (user_id, repo_id)
);
