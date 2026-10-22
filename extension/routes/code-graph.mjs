// POST /kb/ingest-code-graph — the Mac app's structural code graph
// (StructureGraphBuilder output, uploaded by CodeGraphUploadService).
// Own module (was inline in router.mjs) so the code_graph_3d feature group in
// routes/feature-routes.mjs can leave connectors/structure-graph.mjs unloaded
// when the Mac is built without the 3D graph.
//
// Same allow-list gate as /kb/ingest-scip — the repo path is used as the
// storage key and is echoed back to agents, so it must be a repo the user
// has explicitly registered. Large graphs arrive in batches: the client
// sets `replace` on the first batch only.
//
// Contract (mirrors the sibling route modules):
//   handleCodeGraphRoutes(req, res, { userId, url }) → Promise<boolean>

import path from 'node:path';
import * as kb from '../kb/db.mjs';
import { ingestStructureGraph } from '../connectors/structure-graph.mjs';
import { sendJSON, readBody, parseJSON } from '../core/utils.mjs';

export async function handleCodeGraphRoutes(req, res, { userId, url }) {
  if (!(req.method === 'POST' && url === '/kb/ingest-code-graph')) return false;
  const body = parseJSON(await readBody(req));
  if (!body?.repoPath || typeof body.repoPath !== 'string' ||
      !body?.graph || typeof body.graph !== 'object') {
    sendJSON(res, 400, { error: { code: 'VALIDATION_FAILED', message: 'repoPath and graph are required' } });
    return true;
  }
  const normalized = path.resolve(body.repoPath);
  const allowlist = kb.userRepoAllowlist(userId);
  if (!allowlist.includes(normalized)) {
    sendJSON(res, 403, { error: { code: 'PATH_NOT_APPROVED', message: 'Repo path is not on your allow-list' } });
    return true;
  }
  try {
    const result = ingestStructureGraph(userId, normalized, body.graph,
      {
        replace: body.replace === true,
        commitSha: typeof body.commitSha === 'string' ? body.commitSha : null,
        generatedAt: typeof body.generatedAt === 'string' ? body.generatedAt : null,
      });
    sendJSON(res, 200, { ok: true, ...result });
  } catch (err) {
    sendJSON(res, 400, { error: { code: 'CODE_GRAPH_INGEST_FAILED', message: err.message } });
  }
  return true;
}
