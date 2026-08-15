// Static reference catalog of Claude Code's OWN built-in interactive-session
// slash commands (typed inside a `claude` session — /clear, /compact, /help,
// etc.) — NOT the CLI subcommands run from a shell (`claude mcp`, `claude
// agents`, ...), which are a different, already-documented thing, and NOT
// anything discovered from an llm-source or plugin.
//
// Consumed by default-snapshot.mjs to write llm_default_sources/commands/
// commands.json — a reference catalog only. This server never invokes any of
// these; they run inside a `claude` CLI session, not through this codebase.
//
// Source: https://code.claude.com/docs/en/commands.md — update this list by
// hand when Claude Code's own command set changes. Availability varies by
// platform/plan; this is the reference set, not a guarantee every command is
// present in every session.
export const CLAUDE_CODE_COMMANDS = Object.freeze([
  { name: '/help', description: 'Show available commands' },
  { name: '/clear', description: 'Start a new conversation (aliases: /reset, /new)' },
  { name: '/resume', description: 'Return to an earlier conversation' },
  { name: '/branch', description: 'Create a conversation branch' },
  { name: '/rewind', description: 'Restore the code and/or conversation to a previous checkpoint' },
  { name: '/fork', description: 'Copy the conversation to a background session' },
  { name: '/cd', description: 'Change working directory' },
  { name: '/exit', description: 'Exit the CLI (alias: /quit)' },
  { name: '/status', description: 'Show session status' },
  { name: '/model', description: 'Switch AI model' },
  { name: '/effort', description: 'Set model effort level' },
  { name: '/advisor', description: 'Toggle advisor tool' },
  { name: '/fast', description: 'Toggle fast mode' },
  { name: '/context', description: 'Visualize context usage' },
  { name: '/compact', description: 'Summarize the conversation to free up context' },
  { name: '/memory', description: 'Manage CLAUDE.md and auto-memory' },
  { name: '/autocompact', description: 'Set the auto-compact threshold' },
  { name: '/btw', description: 'Ask a side question off the record' },
  { name: '/code-review', description: 'Review a diff for bugs/cleanups with effort levels (alias: /review)' },
  { name: '/security-review', description: 'Check for security vulnerabilities' },
  { name: '/simplify', description: 'Suggest code cleanups' },
  { name: '/verify', description: 'Verify code correctness' },
  { name: '/diff', description: 'View changes interactively' },
  { name: '/batch', description: 'Make parallel codebase changes' },
  { name: '/deep-research', description: 'Fan out web searches with citations' },
  { name: '/goal', description: 'Set a goal that persists across turns' },
  { name: '/loop', description: 'Run a prompt on a recurring interval' },
  { name: '/background', description: 'Detach the current session as a background agent (alias: /bg)' },
  { name: '/tasks', description: 'List background work' },
  { name: '/config', description: 'Configure settings (alias: /settings)' },
  { name: '/permissions', description: 'Manage tool rules (alias: /allowed-tools)' },
  { name: '/mcp', description: 'Manage MCP servers and OAuth' },
  { name: '/add-dir', description: 'Add working-directory access' },
  { name: '/hooks', description: 'View hook configs' },
  { name: '/doctor', description: 'Run setup diagnostics (alias: /checkup)' },
  { name: '/usage', description: 'Show API usage/costs (alias: /cost)' },
  { name: '/keybindings', description: 'Open keyboard shortcuts' },
  { name: '/copy', description: 'Copy the last response' },
  { name: '/export', description: 'Export the conversation' },
  { name: '/color', description: 'Set the prompt-bar color' },
  { name: '/plugin', description: 'Manage plugins' },
  { name: '/reload-plugins', description: 'Reload plugins' },
  { name: '/reload-skills', description: 'Rescan skills' },
  { name: '/login', description: 'Sign in to Anthropic' },
  { name: '/logout', description: 'Sign out' },
  { name: '/desktop', description: 'Open the Desktop app (alias: /app)' },
  { name: '/chrome', description: 'Open Claude in Chrome settings' },
  { name: '/teleport', description: 'Pull a web session to the terminal' },
  { name: '/mobile', description: 'Show a pairing QR code (aliases: /ios, /android)' },
  { name: '/install-github-app', description: 'Install the GitHub integration' },
  { name: '/install-slack-app', description: 'Install the Slack app' },
  { name: '/init', description: 'Initialize CLAUDE.md' },
  { name: '/subtask', description: 'Delegate to a subagent' },
  { name: '/agents', description: 'Manage subagents' },
  { name: '/list-agents', description: 'List other sessions (alias: /peers)' },
  { name: '/dataviz', description: 'Chart/visualization guidance' },
  { name: '/design-sync', description: 'Sync a design system to Claude Design' },
  { name: '/plan', description: 'Enter plan mode' },
  { name: '/debug', description: 'Enable debug logging' },
  { name: '/bug', description: 'Report a bug (alias: /share)' },
  { name: '/feedback', description: 'Send feedback' },
  { name: '/insights', description: 'Usage analysis' },
  { name: '/focus', description: 'Toggle focus view' },
]);
