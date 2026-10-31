// Shared wiring for the Doc Gen and Visual sections: one store per surface for the app's lifetime (the shell keeps
// sections mounted), real host and core bindings, and the shell-bus actions (open a file in Explorer, go to Settings).
import "@llmide/ui-kit/styles.css";
import "../library/library.css";
import "./docgen.css";
import { useCallback, useMemo } from "react";
import { core, host as shellHost, invokeHost, shellBus } from "@llmide/screens/shell";
import type { SectionProps } from "@llmide/screens/shell";
import { createHostFs } from "../explorer/fs";
import { createNotesHost } from "../library/host.ts";
import { publicHttpsUrl } from "../library/safe-url.ts";
import { DocGenScreen } from "./DocGenScreen";
import { hostMermaidRuntime } from "./mermaid/binding.ts";
import { createDocsApi } from "./docs-api.ts";
import { fileReader } from "./fs-reader.ts";
import { notesReader } from "./notes-source.ts";
import { DocGenStore } from "./store.ts";
import type { Surface } from "./model.ts";
import { safeRelativePath } from "../shell/bus";

const stores = new Map<Surface, DocGenStore>();

function storeFor(surface: Surface, fs: ReturnType<typeof createHostFs>, notes: ReturnType<typeof createNotesHost>): DocGenStore {
  let s = stores.get(surface);
  if (!s) {
    s = new DocGenStore({
      surface,
      makeApi: (id, root) => createDocsApi(core, id, root),
      run: { readers: { file: fileReader(fs), note: notesReader(notes) }, fs },
    });
    stores.set(surface, s);
  }
  return s;
}

async function openExternal(url: string): Promise<void> {
  if (!shellHost.isAvailable()) {
    const safe = publicHttpsUrl(url);
    if (safe) window.open(safe, "_blank", "noopener,noreferrer");
    return;
  }
  await invokeHost("open_external_url", { url });
}

export function GenerationSection({ surface, active, projectRoot }: SectionProps & { surface: Surface }) {
  const available = shellHost.isAvailable();
  const deps = useMemo(() => {
    const fs = createHostFs();
    const notes = createNotesHost((cmd, args) => invokeHost(cmd, args));
    return { fs, notes, store: storeFor(surface, fs, notes) };
  }, [surface]);
  const mermaid = useMemo(() => (available ? hostMermaidRuntime(invokeHost) : undefined), [available]);
  const env = useMemo(() => ({ fs: available ? deps.fs : null, notes: available ? deps.notes : null }), [available, deps]);
  const onOpenFile = useCallback((path: string) => {
    const rel = safeRelativePath(path);
    if (rel) shellBus.publish({ type: "open-file", path: rel });
  }, []);
  const onOpenSettings = useCallback(() => shellBus.publish({ type: "goto-section", section: "settings", anchor: "providers" }), []);
  return <DocGenScreen store={deps.store} env={env} active={active} projectRoot={projectRoot} onOpenFile={onOpenFile} onOpenExternal={(u) => void openExternal(u)} onOpenSettings={onOpenSettings} mermaid={mermaid} />;
}
