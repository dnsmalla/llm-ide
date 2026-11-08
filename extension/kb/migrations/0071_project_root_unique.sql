-- 0071: one project per canonical root (R-020 #4, ADR 0022).
--
-- `projects.root` stores the canonical folder spelling (realpath, trailing slashes trimmed, case-folded on the
-- case-insensitive platforms; the write path is kb/projects.mjs `canonicalRoot`). A second id registered on the
-- same folder used to win root resolution (`ORDER BY updated_at`) and bypass the real project's grants. The
-- partial index keeps that from happening again; a folder-less project (root NULL) is not unique.
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_root ON projects(root) WHERE root IS NOT NULL;
