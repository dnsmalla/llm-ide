// Words shown in the source panes. Kept in one file so the claims about what each connector does (and does
// not do) are reviewed together and match docs/spec/connector-catalog.md.

export const PATTERN_A = "Indexed into the core's search index and re-read when you fetch again. No note files are created in your notes folder.";
export const PATTERN_B = "Fetched messages are saved as note files in your notes folder, then recorded as imported so they are not fetched twice.";

export const EMAIL_INTRO =
  "Connects one mailbox over IMAP. It is forward-only: only mail that arrives after you connect is imported, and each message is saved once as a note under source/emails.";
export const EMAIL_APP_PASSWORD =
  "App password: create one in your mail provider's security settings (it needs 2-step verification on Gmail, iCloud and Microsoft accounts) and paste it here. Your normal account password does not work and should never be used. It is stored encrypted in the core's vault and is never shown again.";
export const EMAIL_GOOGLE =
  "Google sign-in: opens Google in your browser. LLM-IDE's own Google client is in testing mode, so only accounts added as test users can use it. To use your own Google Cloud OAuth client instead, enter its client ID and secret below; Google requires you to register the redirect address shown in the core's documentation.";
export const EMAIL_MARK_READ = "Marking messages as read changes your mailbox. It is off by default.";

export const SLACK_INTRO =
  "Reads the channels you pick. Each fetch saves new messages per channel as a note under source/slack and records them as imported.";
export const SLACK_TOKEN_NOTE = "Prefer Connect Slack (browser sign-in). A bot token (xoxb-) only reads channels the bot was invited to; a user token (xoxp-) reads what you can read. Tokens are stored encrypted in the core's vault and never shown again.";

export const BOX_INTRO = `Indexes one Box folder using a server-side app (client-credentials grant). ${PATTERN_A}`;
export const BOX_STOP_NOTE = "Stopping here stops waiting. If the core has already started indexing, it may finish in the background; run it again to be sure it completed.";

export const REPOS_INTRO =
  "Approves a local git repository for the core and indexes its files, so chat and planning can search the code. The core only reads repositories on your approved list. No note files are created.";
export const GITHUB_NOTE = "GitHub issues use the GitHub token saved in Settings. Nothing is written to your notes folder.";

export const CATALOG_INTRO =
  "Connectors you can add. Adding one only shows its card in your Library; it does not give it access to anything.";
export const CATALOG_SELECTION_NOTE =
  "Removing a connector hides its card. It does not sign you out, delete credentials, or stop fetching: if a sign-in is still saved, fetching keeps working until you disconnect it at the provider or in the core.";
export const MCP_UNVERIFIED = "Unverified tools: this connector's tool names and result shapes have not been checked against the live service. Use Test connection to see the tools it really offers; imported notes may be plainer than expected.";
export const NOT_READY = "No import pipeline yet. Nothing is fetched for this connector.";

export const DISCONNECT_TEXT = {
  email: "The mailbox settings are removed and the saved app password is deleted from the vault. A Google sign-in stays until you revoke it in your Google account. Notes already imported are kept.",
  slack: "The channel settings are removed and the saved Slack tokens are deleted from the vault. Notes already imported are kept.",
  box: "The folder settings are removed and the saved client secret is deleted from the vault. Content already indexed stays in the search index. Notes are not affected.",
} as const;
