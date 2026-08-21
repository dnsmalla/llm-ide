// extension/mcp/catalog.mjs
// Curated catalog of MCP servers worth one-clicking, so the "add" flow is not
// limited to importing whatever the user already configured in their Claude or
// Codex CLI (which, for anyone who has configured nothing, is nothing).
//
// EVERY entry here was taken from documentation, not from memory: the seven
// reference servers and their invocation from modelcontextprotocol/servers,
// the rest from Claude Code's own MCP docs (code.claude.com/docs/en/mcp,
// .../mcp-quickstart) — the one exception being `context7`, whose URL and
// header name are copied from a real working config. Package names and URLs
// are the part that breaks silently when guessed, so anything unverified is
// deliberately ABSENT rather than approximated. That is also why the list is
// exactly this long: it is what could be confirmed, not a round number.
//
// This catalog is a starting point, not a registry — the ecosystem moves far
// faster than a hardcoded list. The manual-add path exists for everything
// not here, and the official MCP registry would be the way to make this
// dynamic later.
//
// SAFETY: adding a catalog entry only REGISTERS it. Nothing is spawned or
// connected to until the user separately consents AND enables it
// (effectiveMcpServers gates on both), exactly as for an imported server.
//
// `credential`, when present, names a vault key rather than carrying a value:
//   { vaultKey, target: 'env' | 'header', name, template? }
// The value is stored in the encrypted vault (the same place provider API keys
// live) and injected only when the config is built — so no token is ever
// written into mcp-plugins.json, which is a shared, all-users-readable file.
// `template` interpolates `${value}` for headers that wrap the secret
// (Authorization: Bearer …). Servers behind OAuth carry NO credential: the
// Claude CLI performs the browser sign-in itself (`claude mcp login <name>`),
// so asking for a token here would be wrong.
export const MCP_CATALOG = Object.freeze([
  // ── Official reference servers (modelcontextprotocol/servers) ──────────
  {
    id: 'filesystem',
    name: 'Filesystem',
    description: 'Read, write, and search files under directories you allow.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem'],
    // The server takes the allowed roots as trailing argv. Without at least
    // one it exposes nothing, so the caller must supply it.
    requiresArg: { label: 'Directory to expose', placeholder: '/Users/you/projects' },
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
  },
  {
    id: 'git',
    name: 'Git',
    description: 'Read, search, and manipulate Git repositories.',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-git'],
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/git',
  },
  {
    id: 'fetch',
    name: 'Fetch',
    description: 'Fetch a URL and convert it to markdown for the model.',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-fetch'],
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
  },
  {
    id: 'memory',
    name: 'Memory',
    description: 'Knowledge-graph-backed persistent memory across sessions.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
  },
  {
    id: 'sequential-thinking',
    name: 'Sequential Thinking',
    description: 'Step-by-step reflective problem solving as a tool.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking',
  },
  {
    id: 'time',
    name: 'Time',
    description: 'Current time and timezone conversion.',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-time'],
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/time',
  },
  {
    id: 'everything',
    name: 'Everything (test server)',
    description: 'Reference server exercising every MCP feature — useful for checking that wiring works.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-everything'],
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/everything',
  },

  // ── Local tooling ─────────────────────────────────────────────────────
  {
    id: 'playwright',
    name: 'Playwright',
    description: 'Drive a real browser — navigate, click, fill forms, screenshot.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest'],
    docsUrl: 'https://code.claude.com/docs/en/mcp-quickstart',
  },
  {
    id: 'dbhub',
    name: 'Database (DBHub)',
    description: 'Query Postgres, MySQL, SQLite and friends through one server.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@bytebase/dbhub', '--dsn'],
    requiresArg: { label: 'Connection string (DSN)', placeholder: 'postgresql://readonly:pass@host:5432/db' },
    docsUrl: 'https://code.claude.com/docs/en/mcp',
  },
  {
    id: 'airtable',
    name: 'Airtable',
    description: 'Read and write Airtable bases.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'airtable-mcp-server'],
    credential: {
      vaultKey: 'mcp.airtable.apiKey',
      target: 'env',
      name: 'AIRTABLE_API_KEY',
      label: 'Airtable API key',
    },
    docsUrl: 'https://code.claude.com/docs/en/mcp',
  },

  // ── Hosted (remote HTTP) ──────────────────────────────────────────────
  {
    id: 'github',
    name: 'GitHub',
    description: 'Issues, pull requests, code search and reviews on GitHub.',
    transport: 'http',
    url: 'https://api.githubcopilot.com/mcp/',
    credential: {
      vaultKey: 'mcp.github.token',
      target: 'header',
      name: 'Authorization',
      template: 'Bearer ${value}',
      label: 'GitHub token (a PAT with the scopes you want exposed)',
    },
    docsUrl: 'https://code.claude.com/docs/en/agent-sdk/mcp',
  },
  {
    id: 'sentry',
    name: 'Sentry',
    description: 'Errors, stack traces, and which deploy introduced them.',
    transport: 'http',
    url: 'https://mcp.sentry.dev/mcp',
    // OAuth — the CLI signs in (`claude mcp login sentry`), so no token here.
    oauth: true,
    docsUrl: 'https://code.claude.com/docs/en/mcp-quickstart',
  },
  {
    id: 'notion',
    name: 'Notion',
    description: 'Search and edit Notion pages and databases.',
    transport: 'http',
    url: 'https://mcp.notion.com/mcp',
    oauth: true,
    docsUrl: 'https://code.claude.com/docs/en/mcp',
  },
  {
    id: 'context7',
    name: 'Context7',
    description: 'Up-to-date library and framework documentation, on demand.',
    transport: 'http',
    url: 'https://mcp.context7.com/mcp',
    credential: {
      vaultKey: 'mcp.context7.apiKey',
      target: 'header',
      name: 'CONTEXT7_API_KEY',
      label: 'Context7 API key',
    },
    docsUrl: 'https://context7.com',
  },
  {
    id: 'claude-code-docs',
    name: 'Claude Code docs',
    description: "Claude Code's own documentation, searchable as a tool.",
    transport: 'http',
    url: 'https://code.claude.com/docs/mcp',
    docsUrl: 'https://code.claude.com/docs/en/mcp-quickstart',
  },
]);

/** One catalog entry by id, or null. */
export function catalogEntry(id) {
  return MCP_CATALOG.find((e) => e.id === id) || null;
}
