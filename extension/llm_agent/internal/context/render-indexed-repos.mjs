// Renders the `## Indexed code repositories` section.

export function renderIndexedRepos(agentContext) {
  const repos = agentContext?.indexedRepos;
  const lines = ['## Indexed code repositories (from the user\'s Library)'];
  if (Array.isArray(repos) && repos.length > 0) {
    for (const r of repos) {
      const suffix = r.path ? `     (path: ${r.path})` : '';
      lines.push(`- ${r.name}${suffix}`);
    }
  } else {
    lines.push('- (none indexed)');
  }
  return lines.join('\n');
}
