// Beginner Help & Guide. Every toolbar screen and every Settings group has an entry; tests check coverage against
// the live registries. Plain text only: the dialog renders it as text, and diagrams are CSS boxes, never HTML.
import type { SectionId } from "../shell/sections.ts";

export type HelpGroup = "Start here" | "Screens" | "Settings" | "Recipes";

/** One box of an interactive flowchart: a short label and the plain explanation shown when it is picked. */
export interface FlowNode {
  label: string;
  detail: string;
  /** start = where you begin, step = something you do, check = the app checks or waits, end = the result. */
  tone?: "start" | "step" | "check" | "end";
}
export interface HelpFaq { q: string; a: string }

export interface HelpTopic {
  id: string;
  group: HelpGroup;
  title: string;
  what: string;
  steps: readonly string[];
  example?: string;
  diagram?: "map" | "project" | "factory" | "settings" | "terminal" | "issue";
  /** The screen this topic belongs to; the guide can jump straight there. */
  target?: SectionId;
  /** For Settings topics: the group anchor to open. */
  settingsGroup?: string;
  /** The topic in one plain sentence, shown first. */
  oneLine?: string;
  /** The topic's own flowchart; topics without one use the flow of their diagram kind. */
  flow?: readonly FlowNode[];
  /** Short questions people ask, with plain answers. */
  faq?: readonly HelpFaq[];
  /** Topic ids to read next. */
  related?: readonly string[];
}

const TOPICS: readonly HelpTopic[] = [
  { id: "start", group: "Start here", title: "Your first 10 minutes", what: "LLM-IDE is one workspace for notes, code, issues and AI runs. Start with a project folder, then use the top bar to move between screens.", steps: ["Create or open a project.", "Open Library to see notes, or Explorer to see files.", "Open Chat and ask a question about the project.", "Open Settings → Providers to connect a model."], example: "Try: “Summarise the newest meeting notes and list the action items.”", diagram: "map" , target: "library" },
  { id: "project", group: "Start here", title: "How a project is laid out", what: "A project is a normal folder. LLM-IDE keeps its own data in system/ and writes notes and plans into llm-doc/, next to your code and data.", steps: ["source/ and code/ are yours.", "data/ is for imported files.", "system/ holds settings, caches and the graph.", "llm-doc/ holds notes, plans and generated docs."], example: "Closing a project never deletes files. It only closes the workspace.", diagram: "project" , target: "settings" },
  { id: "navigation", group: "Start here", title: "Finding your way", what: "The top bar lists the screens. The bottom bar shows the project, core status, terminal, notifications and Chat.", steps: ["Click a top-bar name to switch screens.", "Use Ctrl/Cmd+1 Chat, +2 Explorer, +3 Library, +4 Settings.", "Click the Terminal button in the bottom bar, or press Ctrl+`.", "Click Core ready to see diagnostics."], example: "The current screen is highlighted with its own colour." , target: "explorer" },
  { id: "help", group: "Start here", title: "Getting help later", what: "Open your account menu → Help & Guide, or press Ctrl/Cmd+/. Search for a screen or a setting here.", steps: ["Search by name, for example “Gantt” or “Providers”.", "Read What it is, then follow Try it.", "Use a recipe when you want a complete workflow."], example: "Search “Gantt” to learn the timeline before opening it." },

  { id: "explorer", group: "Screens", title: "Explorer", what: "Browse and edit project files, search across folders, review source control, and open the terminal.", steps: ["Use the left tree to open a file.", "Use the Search tab for project-wide text search.", "Use Source Control for changes.", "The terminal button is at the bottom."], example: "Open a file, edit it, then check Source Control for the change." , target: "explorer" },
  { id: "graph", group: "Screens", title: "Graph", what: "Shows how code and documents connect. Large graphs open in an overview; click a node to reveal its neighbours.", steps: ["Choose Code graph or System.", "Click a node to see details.", "Use Filters for kinds and communities.", "Zoom in to reveal more detail."], example: "Find a file, click it, then follow its connected modules." , target: "graph" },
  { id: "autotasks", group: "Screens", title: "Auto Tasks", what: "Runs repeatable jobs such as review, implementation, regression and planning. Each task has a prompt and optional schedule.", steps: ["Pick a task on the left.", "Read Effective prompt.", "Use Run for the open task, or Run all for every enabled task.", "Check Recent runs for what happened."], example: "Run Review Code after changing a file, then read the log." , target: "autotasks" },
  { id: "factory", group: "Screens", title: "Factory", what: "Turns open issues into finished changes. The board shows the process: Backlog, one lane per step (Plan, Implement, Verify, Review…), then Done. Each card sits in the step it is on.", steps: ["Find an open issue in Backlog and click Start.", "Watch the card move through the steps.", "If a card stops (Needs you), open it to read why, then Resume.", "When it reaches Done, review the draft MR and merge it."], example: "#41 waits in Backlog → Start → Plan → Implement → Verify → Review → Done (draft MR open).", diagram: "factory" , target: "conflicts" },
  { id: "issues", group: "Screens", title: "Issues", what: "A board of GitHub and GitLab issues, with comments, labels, milestones, assignees and dates.", steps: ["Choose provider and repository.", "Click an issue card.", "Read comments on the left, settings on the right.", "Comment, close, or Send to Factory."], example: "Open an issue, read its comments, then send it to Factory.", diagram: "issue", target: "issues" },
  { id: "gantt", group: "Screens", title: "Gantt", what: "A timeline of issues with start and due dates. Filter by milestone, range and label.", steps: ["Choose a provider and repository.", "Use Range for Today, ±1 week, month or quarter.", "Click a bar to edit dates.", "Use Today to jump to the current date."], example: "Set Range to This month, then read the start and due dates on each row." , target: "gantt" },
  { id: "loop", group: "Screens", title: "Loop", what: "Runs repeatable workflows. Each loop has a fixed process: numbered steps, each with a prompt or command and checks.", steps: ["Pick a loop on the left, or start a new one from a template.", "Pick a step in Process to switch it on or off and edit its settings.", "Check gates and budgets.", "Run it and follow the log."], example: "A loop can plan, implement, test and review in that order." , target: "loop" },
  { id: "docgen", group: "Screens", title: "Doc Gen", what: "Creates documents from templates and sources, with a chat assistant and image thumbnails.", steps: ["Choose a template.", "Select sources.", "Ask the assistant to draft or change the text.", "Save the result into the project."], example: "Generate a meeting brief from the newest notes." , target: "docgen" },
  { id: "visual", group: "Screens", title: "Visual", what: "A visual workspace for diagrams and generated visuals tied to the project.", steps: ["Open a visual file.", "Edit the diagram or layout.", "Save it to the project."], example: "Use it for an architecture sketch next to the code." , target: "visual" },
  { id: "library", group: "Screens", title: "Library", what: "The hub for notes, documents, code and data. Search everything in one list.", steps: ["Choose Sources, Code, Data or LLM Doc.", "Search by title or content.", "Open an item to read or edit.", "Use Add to bring in a file or folder."], example: "Search for a client name and open the newest note." , target: "library" },
  { id: "live", group: "Screens", title: "Live", what: "Capture and follow a live meeting. Captions become notes and action items.", steps: ["Join the meeting and enable captions.", "Start capture.", "Watch the live transcript.", "Stop capture and open the generated notes."], example: "Use Live for a meeting, then find the note in Library." , target: "live" },
  { id: "chat", group: "Screens", title: "Chat", what: "Ask questions about the project, ask for changes, or continue work from another surface.", steps: ["Pick a model route or use the default.", "Type a question and send.", "Read the answer and linked sources.", "Use the Code Assistant dock in Explorer for file work."], example: "Ask: “Which files handle authentication?”" , target: "chat" },
  { id: "settings", group: "Screens", title: "Settings overview", what: "Settings has app groups and project groups. Open a group to change it; use search to find one.", steps: ["Use Search settings.", "Open one group at a time.", "App groups apply everywhere; Project groups apply to the open project.", "Changes save as you go or with the group's button."], example: "Search “token” to find Providers and Token Saving.", diagram: "settings" , target: "settings" },

  { id: "set-workspace", group: "Settings", title: "Workspace", what: "The open project, notes folder, Home page choice and feature profile.", steps: ["Choose which screen a project opens on.", "Turn sections on or off in the feature profile."], example: "Set Home to Library if you mostly read notes.", target: "settings" , settingsGroup: "workspace" },
  { id: "set-build", group: "Settings", title: "Build", what: "Apply a source build and restart the app, inside Workspace. Only source checkouts have this.", steps: ["Change the profile or code.", "Click Apply & Rebuild.", "Wait for the app to restart."], example: "Use it after editing the desktop source.", target: "settings" , settingsGroup: "workspace" },
  { id: "set-server", group: "Settings", title: "Server & Backend", what: "Start, stop, restart and inspect the local core. Shows the log and port.", steps: ["Check Core ready in the bottom bar.", "Open the log if a screen cannot load.", "Use Start or Kill & Restart."], example: "If every screen says offline, restart the core here.", target: "settings" , settingsGroup: "server" },
  { id: "set-updates", group: "Settings", title: "Updates & About", what: "App version, update checks and release notes.", steps: ["Turn on update checks.", "Install only after the confirmation."], example: "A local test build has no update channel.", target: "settings" , settingsGroup: "updates" },
  { id: "set-mobile", group: "Settings", title: "Phone and browser", what: "Pair a phone or browser with this desktop so it can read snapshots and queue prompts.", steps: ["Open Pairing.", "Scan the QR code or open the link.", "Approve the device."], example: "Queue a prompt from your phone; the desktop answers when online.", target: "settings" , settingsGroup: "mobile" },
  { id: "set-team", group: "Settings", title: "Team", what: "Members, roles and invites for a team hub. Project admins manage their own project.", steps: ["Open Team.", "Invite by email.", "Choose a role.", "Change or remove a member later."], example: "A reviewer can read and comment but not ship.", target: "settings" , settingsGroup: "team" },
  { id: "set-general", group: "Settings", title: "General", what: "Home page, theme and small desktop preferences.", steps: ["Pick a theme.", "Choose what opens after sign-in.", "Turn developer tools on only if needed."], example: "Use Light for daylight, Midnight for a dark room.", target: "settings" , settingsGroup: "general" },
  { id: "set-tool", group: "Settings", title: "Tool permissions", what: "What the AI may do without asking, inside Security: read commands, write commands, network hosts, and always-allow rules.", steps: ["Start with the safest settings.", "Allow one tool or host at a time.", "Revoke a rule when work changes."], example: "Allow a test command for one project, not globally.", target: "settings" , settingsGroup: "trust" },
  { id: "set-sdk", group: "Settings", title: "Claude Agent SDK", what: "The agent engine version and restart controls, inside Server & Backend.", steps: ["Check the installed version.", "Update only when a run asks for it.", "Restart after an update."], example: "An old SDK can make new agent runs fail.", target: "settings" , settingsGroup: "server" },
  { id: "set-token", group: "Settings", title: "Token Saving", what: "Caching and context-saving options for model calls, inside Optional components.", steps: ["Turn on caching if your provider supports it.", "Watch the effect in usage."], example: "Good for long, repeated project questions.", target: "settings" , settingsGroup: "optional-components" },
  { id: "set-providers", group: "Settings", title: "Providers", what: "Connect Claude, OpenAI, Google, DeepSeek or an OpenAI-compatible provider and store its key.", steps: ["Add a provider.", "Paste a write-only key.", "Test the connection.", "Pick it for a task or route."], example: "Keys are stored in the encrypted vault, never shown again.", target: "settings" , settingsGroup: "providers" },
  { id: "set-limits", group: "Settings", title: "Models & limits", what: "The per-user model chain and its caps. Models are tried in order; when one reaches its cap the next enabled model is used.", steps: ["Open Models & limits.", "Enable the models you want.", "Set a cap and window for each.", "Save and refresh to see the active model."], example: "Set a daily cap for a fast model and a monthly cap for the stronger fallback.", target: "settings", diagram: "settings" , settingsGroup: "model-routing" },
  { id: "set-routing", group: "Settings", title: "Model routing", what: "Which model handles each kind of work: chat, planning, review, background jobs and fallbacks.", steps: ["Choose a default.", "Set a cheaper fallback.", "Use one route per job."], example: "Fast model for chat, stronger model for review.", target: "settings" , settingsGroup: "model-routing" },
  { id: "set-memory", group: "Settings", title: "Memory & graph", what: "The project's knowledge graph, agent memory files, and how often the host refreshes the graph.", steps: ["Check whether the graph and memory files exist.", "Ask Chat to summarize them with the graph tools.", "Set a refresh interval, or use Generate in Graph for an immediate rebuild."], example: "The graph is the map behind Graph, citations and project memory.", target: "settings" , settingsGroup: "memory" },
  { id: "set-history", group: "Settings", title: "Agent history", what: "Past agent runs, their results and cleanup controls.", steps: ["Filter by date or project.", "Open a run to read it.", "Clear old history when it grows."], example: "Use it to see why yesterday's review failed.", target: "settings" , settingsGroup: "agent-history" },
  { id: "set-trust", group: "Settings", title: "Security", what: "Folder trust and extension sources: which folders may run project hooks, MCP servers and plugins, and where extensions may be installed from.", steps: ["Read what a folder wants to run.", "Trust it explicitly.", "Revoke trust later."], example: "Untrusted folders run with project servers withheld.", target: "settings" , settingsGroup: "trust" },
  { id: "set-ext-sources", group: "Settings", title: "Extension sources", what: "Where extensions may be installed from (owner/repo or owner/*).", steps: ["Add a source.", "Install from it.", "Remove a source to stop future installs."], example: "Add your team's plugin repository once.", target: "settings" , settingsGroup: "trust" },
  { id: "set-components", group: "Settings", title: "Optional components", what: "Extra renderers such as Mermaid diagrams. Install, update or remove them.", steps: ["Check the state.", "Install.", "Refresh after a download."], example: "Install Mermaid to render diagrams in documents.", target: "settings" , settingsGroup: "optional-components" },
  { id: "set-selfheal", group: "Settings", title: "Self-Heal", what: "Developer-only diagnostics that propose a fix for a failed run.", steps: ["Open an incident.", "Read the proposed diff.", "Apply only after review."], example: "It never applies a fix without a person.", target: "settings" , settingsGroup: "self-heal" },
  { id: "set-paths", group: "Settings", title: "Paths", what: "The project's folder layout: source, code, data, notes and system.", steps: ["Check which folders are present.", "Reveal a folder in Finder/Explorer.", "Create a missing folder."], example: "A missing llm-doc/ is recreated here.", target: "settings" , settingsGroup: "paths" },
  { id: "set-repos", group: "Settings", title: "Repositories", what: "GitHub and GitLab repositories, saved tokens and clone destinations.", steps: ["Add a repository URL.", "Save a token for private repos.", "Clone into code/."], example: "Clone a repo, then run Graph on it.", target: "settings" , settingsGroup: "repositories" },

  { id: "recipe-issue", group: "Recipes", title: "Recipe: issue to shipped change", what: "A complete path from a GitHub or GitLab issue to a reviewed change, without writing the code yourself.", steps: ["Save the repository in Settings → Repositories and import its issues on the Issues screen.", "Open Factory: the issue is in Backlog. Click Start.", "Let it run through the steps; answer if it asks a question.", "In Done, open the draft MR, review it and merge."], example: "The card ends in Done with a draft MR link; merging it removes the card from the board." , target: "conflicts" },
  { id: "recipe-review", group: "Recipes", title: "Recipe: review a change", what: "Run the review task and read the result.", steps: ["Open Auto Tasks.", "Choose Review Code.", "Click Run.", "Read the log and findings."], example: "A failed test appears under Test with the command." , target: "autotasks" },
  { id: "recipe-provider", group: "Recipes", title: "Recipe: connect a model", what: "Add a key and make it the default.", steps: ["Open Settings → Providers.", "Add the provider and paste the key.", "Test it.", "Open Model routing and choose it."], example: "If no key is set, the core falls back to Claude CLI." , target: "settings" },
  { id: "recipe-terminal", group: "Recipes", title: "Recipe: use the terminal", what: "The terminal runs a shell in the project.", steps: ["Click Terminal in the bottom bar.", "Run a command.", "Resize or close the dock.", "Use Ctrl+` anywhere."], example: "Run your project's test command without leaving LLM-IDE.", diagram: "terminal", target: "explorer" },
  { id: "trouble-core", group: "Recipes", title: "Troubleshooting: Core offline", what: "Most screens need the local core.", steps: ["Check Core ready in the bottom bar.", "Open Settings → Server & Backend.", "Read the log.", "Start or Kill & Restart."], example: "A busy port is shown in the status bar; the core may be starting." , target: "settings" },
];

/** The flowchart of each diagram kind (used by every topic of that kind without its own flow). */
export const HELP_FLOWS: Readonly<Record<NonNullable<HelpTopic["diagram"]>, readonly FlowNode[]>> = {
  map: [
    { label: "Open a project", tone: "start", detail: "A project is just a folder on your computer. Everything LLM-IDE does happens inside it, so start by creating or opening one on the Welcome page." },
    { label: "Bring in knowledge", detail: "Library collects meeting notes, documents, email, Slack and code into one searchable list. Explorer shows the raw files." },
    { label: "Ask and explore", detail: "Chat answers questions about the project. Graph shows how files and notes connect. Issues lists the work to do." },
    { label: "Automate", tone: "check", detail: "Factory, Loop and Auto Tasks let the AI do the work in steps: plan, change code, test and review, each one checked." },
    { label: "Review and ship", tone: "end", detail: "Nothing leaves your computer by itself without your OK. You review the result (for example a draft merge request) and decide." },
  ],
  project: [
    { label: "project/", tone: "start", detail: "The folder you opened. It is a normal folder: you can open it in Finder or any editor too." },
    { label: "source/ · code/", detail: "Your own material. code/ is where repositories are cloned. LLM-IDE reads these but does not reorganise them." },
    { label: "data/", detail: "Files you import, such as spreadsheets or exports, so they can be searched and analysed." },
    { label: "llm-doc/", detail: "What the AI writes for you: notes, plans and generated documents, as plain Markdown you can read and edit." },
    { label: "system/", tone: "end", detail: "LLM-IDE's own bookkeeping: settings, loops, the graph and caches. You normally never need to touch it." },
  ],
  factory: [
    { label: "Backlog", tone: "start", detail: "Every open issue of your saved repositories appears here, plus items you added by hand. Click Start on one." },
    { label: "Plan", detail: "The AI reads the issue and the code and writes a short plan of what to change." },
    { label: "Implement", detail: "It makes the change in a separate copy of the repository (a worktree), so your own work is never touched." },
    { label: "Verify", tone: "check", detail: "Your test command runs. If a test fails, the AI tries to repair it a few times; if it still fails the card stops here with Needs you." },
    { label: "Review", tone: "check", detail: "A second AI pass reviews the change against the issue and the plan, like a colleague would." },
    { label: "Done", tone: "end", detail: "A draft merge request is opened for you. Review and merge it; a merged card leaves the board. A comment on the MR restarts the run." },
  ],
  settings: [
    { label: "Search settings", tone: "start", detail: "Type what you want to change, for example “theme”, “key” or “token”. Matching groups open for you." },
    { label: "App settings", detail: "Apply everywhere on this computer: providers and keys, models, theme, phone pairing, security." },
    { label: "Project settings", detail: "Apply only to the open project: its folders, repositories, memory and graph." },
    { label: "Save", tone: "end", detail: "Most switches save as soon as you change them. Groups with text fields have their own Save button." },
  ],
  issue: [
    { label: "Pick a repository", tone: "start", detail: "Issues shows the GitHub and GitLab repositories you saved in Settings → Repositories." },
    { label: "Open an issue", detail: "Click a card. The discussion is on the left; status, labels, milestone, people and dates are on the right." },
    { label: "Edit or comment", detail: "Change any field in place or write a comment. It is sent to GitHub or GitLab straight away." },
    { label: "Send to Factory", tone: "end", detail: "Want the AI to do it? The issue is already in Factory's Backlog; click Start there." },
  ],
  terminal: [
    { label: "Open the dock", tone: "start", detail: "Click Terminal in the bottom bar, or press Ctrl+` anywhere." },
    { label: "Run a command", detail: "It is a normal shell, already inside your project folder. For example run your tests." },
    { label: "Read the output", tone: "end", detail: "Output stays in the dock while you switch screens. Close or resize it from its top edge." },
  ],
};

/** Plain one-liners, flows, questions and next reads, per topic id. Merged into HELP_TOPICS below. */
const EXTRAS: Readonly<Record<string, Pick<HelpTopic, "oneLine" | "flow" | "faq" | "related">>> = {
  start: { oneLine: "Open a folder, collect what you know in Library, ask Chat, and let Factory do the coding work.", related: ["project", "navigation", "recipe-provider"],
    faq: [{ q: "Do I need an API key?", a: "No. If you are logged in to the Claude CLI (claude login) it is used by default. A key is optional and lives in Settings → Providers." }, { q: "Does my data leave my computer?", a: "Only when you allow it: model calls go to your provider, and pushes, issues and merge requests happen only after you click." }] },
  project: { oneLine: "A project is an ordinary folder; LLM-IDE adds two folders of its own: llm-doc/ for notes and system/ for settings.", related: ["set-paths", "library"],
    faq: [{ q: "Will closing a project delete anything?", a: "No. Closing only closes the window's workspace; every file stays where it is." }] },
  navigation: { oneLine: "Top bar = screens. Bottom bar = project, core status, terminal, notifications and Chat.", related: ["help", "trouble-core"],
    flow: [
      { label: "Top bar", tone: "start", detail: "Every screen is one click away: Explorer, Library, Graph, Issues, Factory, Loop and more." },
      { label: "Shortcuts", detail: "Ctrl/Cmd+1 Chat, +2 Explorer, +3 Library, +4 Settings, Ctrl/Cmd+/ opens this Help." },
      { label: "Bottom bar", tone: "end", detail: "Shows the open project and whether the core is ready, and opens the terminal, notifications and the Chat popup." },
    ] },
  help: { oneLine: "Search a word, read the one-line answer, click the boxes in the flowchart, then press Open to go there.", related: ["start"],
    flow: [
      { label: "Open Help", tone: "start", detail: "Click Help & Support in the bottom bar, or press Ctrl/Cmd+/ from anywhere." },
      { label: "Search or pick", detail: "Type a word such as “key” or “offline”, or pick a topic on the left." },
      { label: "Click the steps", detail: "Each topic has a flowchart: click a box, or use Back and Next, to read what happens there." },
      { label: "Go there", tone: "end", detail: "Press Open (or ↗ in the list) to jump straight to that screen or setting." },
    ] },
  explorer: { oneLine: "Your project's files, with search, source control and a terminal, like a code editor.", related: ["recipe-terminal", "chat"],
    flow: [
      { label: "File tree", tone: "start", detail: "Click a file on the left to open it in a tab. Edits are saved with Cmd/Ctrl+S." },
      { label: "Search", detail: "The Search tab finds text in every file of the project." },
      { label: "Source Control", detail: "Shows what changed since the last commit. Stage, commit and see diffs without a terminal." },
      { label: "Code Assistant", tone: "end", detail: "The docked chat works on the open files: ask it to explain or change code." },
    ] },
  graph: { oneLine: "A map of your code and notes: dots are files or ideas, lines are links between them.", related: ["set-memory", "chat"],
    flow: [
      { label: "Open a graph", tone: "start", detail: "Pick Code graph (your repository) or System. Big graphs first show an overview." },
      { label: "Search or click", detail: "Type a name in the search box, or click a dot to select it." },
      { label: "Follow the links", detail: "The selected dot's neighbours light up. Double-click to focus on just that neighbourhood." },
      { label: "Ask about it", tone: "end", detail: "Chat can use the graph too: ask “what depends on this file?”." },
    ],
    faq: [{ q: "The graph is empty.", a: "Open Advanced → Generate graph, pick the repository and click Generate Code Graph." }] },
  autotasks: { oneLine: "Ready-made jobs (review, implement, regression, plan) you can run now or on a schedule.", related: ["recipe-review", "loop"],
    flow: [
      { label: "Pick a task", tone: "start", detail: "The list on the left holds built-in tasks and your own." },
      { label: "Check the prompt", detail: "Effective prompt shows exactly what the AI will be told." },
      { label: "Run", tone: "check", detail: "Run starts it now; a schedule runs it automatically while the app is open." },
      { label: "Read the result", tone: "end", detail: "Recent runs keeps every result with its log." },
    ] },
  factory: { oneLine: "Pick an open issue, click Start, and the AI plans, codes, tests and reviews it, then opens a draft merge request.", related: ["recipe-issue", "issues", "loop"],
    faq: [
      { q: "What does “Needs you” mean?", a: "The run stopped and needs a person: a test kept failing, the app closed mid-run, or CI failed on the MR. Open the card to see why, then Resume." },
      { q: "Can it break my code?", a: "No. Each run works in its own copy of the repository (a worktree). Your files change only when you merge the MR." },
      { q: "How do I change the steps?", a: "Factory → Process tab. The board's lanes follow it." },
    ] },
  issues: { oneLine: "Your GitHub and GitLab issues, readable and editable in one place.", related: ["gantt", "factory", "set-repos"] },
  gantt: { oneLine: "The same issues on a timeline, from start date to due date.", related: ["issues"],
    flow: [
      { label: "Pick a repository", tone: "start", detail: "Gantt shows the issues of your saved repositories." },
      { label: "Choose a range", detail: "Today, ±1 week, this month or the quarter." },
      { label: "Drag or click a bar", detail: "Move dates by dragging, or click to edit start and due dates exactly." },
      { label: "Dates sync", tone: "end", detail: "GitLab's due date and the Issues screen show the same dates." },
    ] },
  loop: { oneLine: "A loop repeats a fixed list of steps (for example fix → test) until every check passes or a budget runs out.", related: ["factory", "autotasks"],
    flow: [
      { label: "Pick a loop", tone: "start", detail: "Each loop on the left has its own fixed process, for example Regression, Test or Refactoring." },
      { label: "Check its steps", detail: "Process lists the numbered steps. Click one to switch it off or change its command or prompt." },
      { label: "Run", tone: "check", detail: "Every step runs in order. If a check fails, the AI repairs and the loop tries again." },
      { label: "Stops when green", tone: "end", detail: "It stops when every check passes, or at the iteration or time budget. The log on the right shows everything." },
    ],
    faq: [{ q: "Why can't I add or reorder steps?", a: "Each loop has a fixed process so it behaves the same every time. Start a new loop from another template instead." }] },
  docgen: { oneLine: "Pick a template and some sources; the assistant drafts the document for you.", related: ["library"],
    flow: [
      { label: "Template", tone: "start", detail: "Choose what you are making, for example a meeting brief or a report." },
      { label: "Sources", detail: "Tick the notes, files or data the document should be based on." },
      { label: "Draft", tone: "check", detail: "The assistant writes a draft. Ask it in the chat column to change anything." },
      { label: "Save", tone: "end", detail: "Save it into the project; it becomes a normal file you can open anywhere." },
    ] },
  visual: { oneLine: "Draw and keep diagrams next to your project files.", related: ["docgen"],
    flow: [
      { label: "Open a visual", tone: "start", detail: "Open an existing diagram file, or start a new one." },
      { label: "Edit", detail: "Move boxes, change the layout or let the assistant generate a visual." },
      { label: "Save", tone: "end", detail: "It is saved as a file in the project, next to the code it describes." },
    ] },
  library: { oneLine: "Everything you know about the project, searchable in one list.", related: ["live", "chat"],
    flow: [
      { label: "Sources arrive", tone: "start", detail: "Meetings, email, Slack, Box, documents and code are collected automatically or with Add." },
      { label: "Search", detail: "Type any word; titles and full text are searched." },
      { label: "Read or edit", detail: "Open an item to read it. Notes are Markdown files in llm-doc/." },
      { label: "Use it", tone: "end", detail: "Chat and Factory use the Library as their knowledge when answering or planning." },
    ] },
  live: { oneLine: "Turn a meeting's captions into notes and action items.", related: ["library"],
    flow: [
      { label: "Captions on", tone: "start", detail: "Join Meet, Teams or Zoom and switch on captions." },
      { label: "Start capture", detail: "LLM-IDE reads the captions as the meeting goes." },
      { label: "Stop", tone: "check", detail: "When the meeting ends, stop capture." },
      { label: "Notes ready", tone: "end", detail: "A note with a summary and action items appears in Library." },
    ] },
  chat: { oneLine: "Ask anything about your project in plain words; Execute mode can also change files.", related: ["explorer", "set-routing"],
    flow: [
      { label: "Ask", tone: "start", detail: "Type a question. Ask mode only reads; it never changes files." },
      { label: "It looks things up", tone: "check", detail: "It searches your files, notes and graph, and shows what it used." },
      { label: "Answer", detail: "The answer links to the files and notes it used, with the cost of the reply." },
      { label: "Want a change?", tone: "end", detail: "Switch to Execute to let it edit files; it asks before risky actions." },
    ],
    faq: [{ q: "Why did it suggest a new chat?", a: "Long chats cost more tokens. A fresh chat starts from a short recap, so answers stay fast and cheap." }] },
  settings: { oneLine: "Search for what you want to change; app groups apply everywhere, project groups only to this folder.", related: ["set-providers", "set-general"] },
  "set-mobile": { oneLine: "Use LLM-IDE from your phone or a browser: live while the desktop is on, from encrypted sync when it is off.", related: ["set-team"],
    flow: [
      { label: "Online tab", tone: "start", detail: "Shows a QR code and a PIN for live chat while this desktop is running." },
      { label: "Scan or open link", detail: "Scan the QR with the iPhone app, or open the link in a browser." },
      { label: "Approve", tone: "check", detail: "Approve the new device on the desktop. Every phone-started run also waits for your approval here." },
      { label: "Offline tab", tone: "end", detail: "Optional: set up encrypted sync (your server, Box or MEGA) so history is readable when the desktop is off." },
    ] },
  "set-providers": { oneLine: "Connect an AI provider by pasting its key once; it is stored encrypted and never shown again.", related: ["recipe-provider", "set-routing", "set-limits"] },
  "set-limits": { oneLine: "Put your models in order and give each a cap; when one is used up the next one takes over.", related: ["set-routing"],
    flow: [
      { label: "Model 1", tone: "start", detail: "The first enabled model handles the work." },
      { label: "Cap reached?", tone: "check", detail: "Each model has a cap per day, week or month that you set." },
      { label: "Model 2", detail: "When the cap is reached, the next enabled model in the chain is used." },
      { label: "Window resets", tone: "end", detail: "When the window resets, the first model is used again." },
    ] },
  "set-routing": { oneLine: "Choose which model does which job, for example a cheap one for chat and a strong one for review.", related: ["set-limits", "set-providers"] },
  "set-repos": { oneLine: "Save your GitHub or GitLab repositories once; Issues, Gantt and Factory then use them.", related: ["issues", "factory"],
    flow: [
      { label: "Add URL", tone: "start", detail: "Paste the repository's address, for example https://gitlab.com/group/project." },
      { label: "Token", detail: "For private repositories, save a token. It is stored encrypted." },
      { label: "Clone", tone: "check", detail: "Clone it into code/ so Factory and Graph can work on it." },
      { label: "Used everywhere", tone: "end", detail: "Its issues appear in Issues, Gantt and Factory's Backlog." },
    ] },
  "recipe-issue": { oneLine: "Issue → Start in Factory → the AI does the steps → you review and merge the draft MR.", related: ["factory", "set-repos"], flow: HELP_FLOWS.factory },
  "recipe-review": { oneLine: "Run Review Code and read what it found.", related: ["autotasks"],
    flow: [
      { label: "Auto Tasks", tone: "start", detail: "Open the Auto Tasks screen." },
      { label: "Review Code", detail: "Pick the Review Code task on the left." },
      { label: "Run", tone: "check", detail: "Click Run. It reads the recent changes and checks them." },
      { label: "Findings", tone: "end", detail: "Read the findings in the log; each one names the file and what to fix." },
    ] },
  "recipe-provider": { oneLine: "Paste a key in Providers, test it, then pick it in Model routing.", related: ["set-providers", "set-routing"],
    flow: [
      { label: "Providers", tone: "start", detail: "Settings → Providers → Add, then choose the provider." },
      { label: "Paste key", detail: "The key is write-only: once saved it is never shown again." },
      { label: "Test", tone: "check", detail: "Test the connection; a clear error tells you what to fix." },
      { label: "Route it", tone: "end", detail: "Settings → Model routing: pick it for chat, planning or review." },
    ] },
  "recipe-terminal": { oneLine: "A shell inside your project, one click from any screen.", related: ["explorer"] },
  "trouble-core": { oneLine: "If screens say offline, the local core is stopped: restart it from Settings → Server & Backend.", related: ["set-server"],
    flow: [
      { label: "Bottom bar", tone: "start", detail: "Look at the core status. “Core ready” means all is well." },
      { label: "Open Server & Backend", detail: "Settings → Server & Backend shows the core's state and its log." },
      { label: "Read the log", tone: "check", detail: "The last lines usually say why: a busy port, a missing tool, or a crash." },
      { label: "Restart", tone: "end", detail: "Click Start, or Kill & Restart. Screens reconnect by themselves." },
    ],
    faq: [{ q: "It says the port is in use.", a: "Another program uses port 3456. Quit it (lsof -i :3456 shows which), then restart the core." }] },
};

export const HELP_TOPICS: readonly HelpTopic[] = TOPICS.map((t) => ({ ...t, ...EXTRAS[t.id] }));

/** The flowchart a topic shows: its own, else its diagram kind's, else none. */
export function topicFlow(t: HelpTopic): readonly FlowNode[] | null {
  return t.flow ?? (t.diagram ? HELP_FLOWS[t.diagram] : null);
}

export const HELP_GROUPS: readonly HelpGroup[] = ["Start here", "Screens", "Settings", "Recipes"];
