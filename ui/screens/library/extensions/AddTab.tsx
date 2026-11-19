// Add tab: every way to add an extension, as labelled choices. Each choice opens the dialog or form that already
// exists for it (the legacy dialogs in LegacyPane.tsx, the GitHub form in InstallTab.tsx); nothing is re-implemented.
import { useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import { InstallTab } from "./InstallTab.tsx";
import { AddMcpDialog, AddSourceDialog, ImportClaudeDialog, ImportCodexDialog, InstallPluginGitDialog } from "./LegacyPane.tsx";
import type { LegacyKind, LegacyModel } from "./legacy.ts";
import type { ExtensionsModel, ExtensionsState } from "./model.ts";

export type AddChoice = "catalog" | "github" | "git" | "claude" | "codex" | "mcp" | "kit";

/** The choices in order; `kind` is the list (and model) whose dialog a choice opens. */
export const ADD_CHOICES: readonly { id: AddChoice; label: string; hint: string; kind?: LegacyKind }[] = [
  { id: "catalog", label: "From the catalog", hint: "Browse skills, plugins and MCP servers." },
  { id: "github", label: "From GitHub", hint: "Install by repository address. It is pinned and installed switched off." },
  { id: "git", label: "Plugin from Git", hint: "Add a plugin from a public Git address.", kind: "plugins" },
  { id: "claude", label: "Import from Claude Code", hint: "Copy a plugin you already use in Claude Code.", kind: "plugins" },
  { id: "codex", label: "Import from Codex", hint: "Copy a plugin you already use in Codex.", kind: "plugins" },
  { id: "mcp", label: "MCP server", hint: "Add a server by command or address.", kind: "mcp-plugins" },
  { id: "kit", label: "Skill kit", hint: "Add a folder or Git repository of skills, agents and commands.", kind: "llm-sources" },
];

function Notice({ model }: { model: LegacyModel }): ReactNode {
  const n = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot).notice;
  // Only a notice raised after this tab opened (by an add or import here); an older one belongs to its own view.
  const before = useRef(n);
  return n && n !== before.current ? <StatusBanner severity={n.error ? "error" : "info"} message={n.text} onDismiss={() => model.dismissNotice()} /> : null;
}

export function AddTab({ model, state, legacy, initialChoice = "github" }: { model: ExtensionsModel; state: ExtensionsState; legacy?: Partial<Record<LegacyKind, LegacyModel>>; initialChoice?: AddChoice | null }): ReactNode {
  const [open, setOpen] = useState<AddChoice | null>(initialChoice);
  const close = (): void => setOpen(null);
  const choose = (c: AddChoice): void => {
    if (c === "catalog") void model.showTab("browse");
    else setOpen(c);
    // The list a dialog adds to is read now, so the new row shows up when the user looks at it.
    const kind = ADD_CHOICES.find((x) => x.id === c)?.kind;
    if (kind) void legacy?.[kind]?.ensureLoaded();
  };
  const dlg = (kind: LegacyKind): LegacyModel | undefined => legacy?.[kind];
  const plugins = dlg("plugins");
  const mcp = dlg("mcp-plugins");
  const kits = dlg("llm-sources");
  return (
    <div className="ext-add">
      <ul className="ext-add-list" aria-label="Ways to add an extension">
        {ADD_CHOICES.map((c) => {
          const missing = c.kind !== undefined && !dlg(c.kind);
          return (
            <li key={c.id}>
              <button type="button" className="lib-btn" aria-pressed={c.id === "github" ? open === "github" : undefined} disabled={missing || (c.id === "github" && state.catalogOff)} onClick={() => choose(c.id)}>
                {c.label}
              </button>
              <span className="lib-muted"> {c.hint}</span>
            </li>
          );
        })}
      </ul>
      {[plugins, mcp, kits].map((m) => (m ? <Notice key={m.kind} model={m} /> : null))}
      {(open === "github" || state.install.last) && <InstallTab model={model} state={state} />}
      {open === "git" && plugins ? <InstallPluginGitDialog model={plugins} onClose={close} /> : null}
      {open === "claude" && plugins ? <ImportClaudeDialog model={plugins} onClose={close} /> : null}
      {open === "codex" && plugins ? <ImportCodexDialog model={plugins} onClose={close} /> : null}
      {open === "mcp" && mcp ? <AddMcpDialog model={mcp} onClose={close} /> : null}
      {open === "kit" && kits ? <AddSourceDialog model={kits} onClose={close} /> : null}
    </div>
  );
}
