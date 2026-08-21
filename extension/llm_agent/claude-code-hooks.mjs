// Static reference catalog of Claude Code's hook EVENTS — the lifecycle points
// a hook can be attached to. Sibling of claude-code-commands.mjs, and the same
// kind of thing: a hand-maintained reference list, never executed here.
//
// Why events and not hooks: Claude Code ships no built-in hook
// IMPLEMENTATIONS. Every hook is supplied by a user, a project, or a plugin —
// so unlike the built-in slash commands there is no default set to catalogue.
// What IS fixed is the event vocabulary, which is what someone writing a hook
// actually needs to look up. Hooks that real sources declare are a separate
// thing, discovered per-source by listDiscoveryHooks (llm-sources/registry.mjs)
// and written to llm_default_sources/hooks/hooks.json.
//
// Consumed by default-snapshot.mjs to write llm_default_sources/hooks/
// events.json.
//
// Source: the `HookEvent` union in Claude Code's Agent SDK reference
// (https://code.claude.com/docs/en/agent-sdk/typescript), which is the
// authoritative enumeration; see also
// https://code.claude.com/docs/en/hooks-guide for the settings.json shape.
// Update by hand when the event set changes. Two caveats, deliberate:
//   • Not every event is necessarily configurable from settings.json — some
//     are reachable only through the SDK's programmatic hook API. This is a
//     vocabulary reference, not a guarantee of settings support.
//   • `description` is our own one-line gloss, not upstream text. The event
//     NAMES are the authoritative part.
export const CLAUDE_CODE_HOOK_EVENTS = Object.freeze([
  // Tool lifecycle — the most commonly used events. `matcher` selects tools by
  // name (e.g. "Bash", "Edit|Write").
  { name: 'PreToolUse', description: 'Before a tool call runs; can block it or ask for approval' },
  { name: 'PostToolUse', description: 'After a tool call completes successfully' },
  { name: 'PostToolUseFailure', description: 'After a tool call fails' },
  { name: 'PostToolBatch', description: 'After a batch of tool calls completes' },
  { name: 'PermissionRequest', description: 'When a tool call requires a permission decision' },
  { name: 'PermissionDenied', description: 'When a permission decision refuses a tool call' },

  // Session lifecycle.
  { name: 'SessionStart', description: 'When a session starts or resumes — the usual place to load context' },
  { name: 'SessionEnd', description: 'When a session ends' },
  { name: 'Setup', description: 'Environment setup for a session' },
  { name: 'InstructionsLoaded', description: 'After instruction files (CLAUDE.md and friends) are loaded' },
  { name: 'ConfigChange', description: 'When configuration changes during a session' },

  // Turn lifecycle.
  { name: 'UserPromptSubmit', description: 'When the user submits a prompt, before the model sees it' },
  { name: 'UserPromptExpansion', description: 'When a submitted prompt is expanded' },
  { name: 'Stop', description: 'When the main agent finishes responding' },
  { name: 'StopFailure', description: 'When the main agent stops because of a failure' },
  { name: 'MessageDisplay', description: 'When a message is displayed' },
  { name: 'Notification', description: 'When Claude Code raises a notification' },

  // Subagents and tasks.
  { name: 'SubagentStart', description: 'When a subagent starts; `matcher` selects by agent name' },
  { name: 'SubagentStop', description: 'When a subagent finishes' },
  { name: 'TaskCreated', description: 'When a task is created' },
  { name: 'TaskCompleted', description: 'When a task completes' },
  { name: 'TeammateIdle', description: 'When a teammate session goes idle' },

  // Context compaction.
  { name: 'PreCompact', description: 'Before the conversation is compacted' },
  { name: 'PostCompact', description: 'After the conversation is compacted' },

  // Elicitation (prompts back to the caller).
  { name: 'Elicitation', description: 'When input is elicited from the user' },
  { name: 'ElicitationResult', description: 'When an elicitation is answered' },

  // Workspace and filesystem.
  { name: 'DirectoryAdded', description: 'When a directory is added to the session' },
  { name: 'CwdChanged', description: 'When the working directory changes' },
  { name: 'FileChanged', description: 'When a watched file changes' },
  { name: 'WorktreeCreate', description: 'When a git worktree is created' },
  { name: 'WorktreeRemove', description: 'When a git worktree is removed' },
]);
