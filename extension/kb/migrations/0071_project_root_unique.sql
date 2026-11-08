-- 0071: one project per canonical root (R-020 #4, ADR 0022).
--
-- `projects.root` stores the canonical folder spelling (realpath, trailing slashes trimmed, case-folded on the
-- case-insensitive platforms; the write path is kb/projects.mjs `canonicalRoot`). A second id registered on the
-- same folder used to win root resolution (`ORDER BY updated_at`) and bypass the real project's grants. The
-- partial index keeps that from happening again; a folder-less project (root NULL) is not unique.
-- A DB written after R-020 #4's code fix can still hold duplicate roots from before it (the state the index
-- would refuse to migrate). Keep the OLDEST row's folder link and drop only the hijacked duplicate's link: ids,
-- names and grants stay, and no project disappears.
UPDATE projects
   SET root = NULL
 WHERE root IS NOT NULL
   AND rowid NOT IN (SELECT MIN(rowid) FROM projects WHERE root IS NOT NULL GROUP BY root);

CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_root ON projects(root) WHERE root IS NOT NULL;
