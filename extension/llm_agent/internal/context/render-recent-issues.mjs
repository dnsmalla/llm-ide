// Renders the `## Recent open issues` section. Empty array → empty
// string (no section rendered) so the prompt isn't polluted when the
// user has no open issues.

export function renderRecentIssues(agentContext) {
  const issues = agentContext?.recentIssues;
  if (!Array.isArray(issues) || issues.length === 0) return '';
  const lines = [`## Recent open issues (${issues.length}, most-recently-updated)`];
  for (const issue of issues) {
    const labels = Array.isArray(issue.labels) && issue.labels.length > 0
      ? ` [${issue.labels.join(', ')}]`
      : '';
    lines.push(`- #${issue.iid} ${issue.title}${labels}`);
    if (issue.snippet) {
      const single = String(issue.snippet).replace(/\s+/g, ' ').trim();
      if (single) lines.push(`    ${single}`);
    }
  }
  lines.push('');
  lines.push('_Note: the list above is a snapshot of the 15 most-recently-updated OPEN issues. If the user references an issue you do not see here, ask for the iid or title; do not guess._');
  return lines.join('\n');
}
