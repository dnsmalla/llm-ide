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
import { renderGraphifyMemory } from '../../../graphkit/index.mjs';
import { redactFence } from '../../runtime/redaction.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_CAPABILITIES_PATH = join(__dirname, 'app-capabilities.md');

// Cache the static markdown once per process.
const appCapabilities = readFileSync(APP_CAPABILITIES_PATH, 'utf8').trim();

// `userMessage` (optional) is the question this turn is answering. It is used
// only to rank curated chat-memory facts by relevance inside
// renderGraphifyMemory; omitting it degrades that selection to newest-first,
// never to an error.
export function composeSystemContext(agentContext, userId, userMessage = '') {
  const sections = [
    '# System context',
    '',
    appCapabilities,
    renderActiveProject(agentContext),
    renderIndexedRepos(agentContext),
    renderRecentIssues(agentContext),
    renderRecentMeetings(agentContext),
    // Surfaces the Mac app's Graphify-generated memory (repo.md,
    // graph-notes.md, prior fault reports, prior Q&A) so the internal
    // agent benefits from the same context external CLIs already see.
    // userId is required so we can gate path reads against the user's
    // registered repo allow-list. `stats` is omitted deliberately: route.mjs
    // already logs one `memory_context` line per turn for the global agent's
    // copy of this same block, and a second sink would double-count it.
    renderGraphifyMemory(agentContext, userId, undefined, userMessage),
  ];
  // Neutralise fence sentinels across the whole block: issue titles, meeting
  // content, repo names, and Graphify memory are all external/user-derived and
  // flow straight into the internal agent's system prompt. A `<<<TOOL_CALL>>>`
  // smuggled in via a meeting title or a repo doc must not be able to prime a
  // forged tool call. (Same defense the loop applies to user messages, history,
  // and tool results — and that route.mjs applies to the global memory block.)
  // redactFence only touches `<<<`/`>>>`, so the static capabilities text and
  // section headers are unchanged.
  const block = sections.filter((s) => typeof s === 'string' && s.length > 0).join('\n\n');
  return redactFence(block);
}
