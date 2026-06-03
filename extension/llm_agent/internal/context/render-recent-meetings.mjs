// Renders the `## Recent meetings` section.

export function renderRecentMeetings(agentContext) {
  const meetings = agentContext?.recentMeetings;
  if (!Array.isArray(meetings) || meetings.length === 0) return '';
  const lines = [`## Recent meetings (${meetings.length}, most-recent first)`];
  for (const m of meetings) {
    const date = m.date ? m.date.slice(0, 10) : '—';
    const peeps = (m.participantCount && m.participantCount > 0) ? ` · ${m.participantCount} participant(s)` : '';
    lines.push(`- ${date} · ${m.title}${peeps}`);
  }
  lines.push('');
  lines.push('_For meeting bodies / decisions / action items, call `search-kb` with a query. Titles above are just a header — do not invent quotes from them._');
  return lines.join('\n');
}
