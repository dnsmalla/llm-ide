// Composes the full `# System context` block from the static
// app-capabilities markdown plus the four agentContext-driven
// renderers. Empty sections are filtered out so the prompt stays
// readable.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { renderActiveProject } from './render-active-project.mjs';
import { renderIndexedRepos } from './render-indexed-repos.mjs';
import { renderRecentIssues } from './render-recent-issues.mjs';
import { renderRecentMeetings } from './render-recent-meetings.mjs';
import { renderGraphifyMemory } from './render-graphify-memory.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_CAPABILITIES_PATH = join(__dirname, 'app-capabilities.md');

// Cache the static markdown once per process.
const appCapabilities = readFileSync(APP_CAPABILITIES_PATH, 'utf8').trim();

export function composeSystemContext(agentContext, userId) {
  const sections = [
    '# System context',
    '',
    appCapabilities,
    renderActiveProject(agentContext),
    renderIndexedRepos(agentContext),
    renderRecentIssues(agentContext),
    renderRecentMeetings(agentContext),
    // Surfaces the Mac app's Graphify-generated memory (repo.md,
    // graph-notes.md, prior bug reports, prior Q&A) so the internal
    // agent benefits from the same context external CLIs already see.
    // userId is required so we can gate path reads against the user's
    // registered repo allow-list.
    renderGraphifyMemory(agentContext, userId),
  ];
  return sections.filter((s) => typeof s === 'string' && s.length > 0).join('\n\n');
}
