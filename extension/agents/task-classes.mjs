// The action class a core-route task needs at execution time. The HTTP route is declared once as model.read
// (ROUTE_POLICY) and the handler re-checks the task's own class through this table; a core-route task with no
// entry is refused rather than running with only the route's class.
export const TASK_CLASS = Object.freeze({
  'sources-update': 'external.read',
  'plan-status': 'external.read',
  // The same class the Issues board's create route uses (routes/issue-writes.mjs).
  'issues-from-notes': 'external.write',
});
