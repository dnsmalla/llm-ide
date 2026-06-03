// Renders the `## Active project` section of the system
// context. Returns empty string when the user hasn't configured an
// active project — the composer drops empty sections.

export function renderActiveProject(agentContext) {
  const p = agentContext?.activeProject;
  const lines = ['## Active project'];
  if (p) {
    lines.push(`- Name: ${p.name || '(unnamed)'}`);
    lines.push(`- URL: ${p.url || '(no url)'}`);
    if (p.defaultBranch) lines.push(`- Default branch: ${p.defaultBranch}`);
  } else {
    lines.push('- (none configured)');
  }
  return lines.join('\n');
}
