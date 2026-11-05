// Shared wiring for the Doc Gen and Visual sections: one store per surface for the app's lifetime (the shell keeps
// sections mounted), real host and core bindings, and the shell-bus actions (open a file in Explorer, go to Settings).
import "@llmide/ui-kit/styles.css";
import "../library/library.css";
import "./docgen.css";
import { useCallback, useMemo, useState } from "react";
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
import { imageReader } from "./image-reader.ts";
import { DocGenStore } from "./store.ts";
import type { Surface } from "./model.ts";
import { safeRelativePath } from "../shell/bus";
import { REVEAL_FAILED } from "./reveal.ts";
import { pickTemplateFile } from "./template-file.ts";

const stores = new Map<Surface, DocGenStore>();

function storeFor(surface: Surface, fs: ReturnType<typeof createHostFs>, notes: ReturnType<typeof createNotesHost>): DocGenStore {
  let s = stores.get(surface);
  if (!s) {
    s = new DocGenStore({
      surface,
      makeApi: (id, root) => createDocsApi(core, id, root),
      run: { readers: { file: fileReader(fs), note: notesReader(notes), image: imageReader((cmd, args) => invokeHost(cmd, args)) }, fs, destination: (() => { try { return localStorage.getItem("llmide.docgen.destination") ?? undefined; } catch { return undefined; } })() },
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
  const [revealNotice, setRevealNotice] = useState<string | null>(null);
  const [exportNotice, setExportNotice] = useState<{ kind: "ok" | "error"; message: string } | null>(null);
  const onReveal = useCallback((path: string) => {
    if (!available) return;
    setRevealNotice(null);
    const rel = safeRelativePath(path);
    if (!rel) { setRevealNotice(REVEAL_FAILED); return; }
    // A failure is shown, not swallowed: the screen's banner says the file could not be shown.
    void invokeHost("reveal_in_os", { relPath: rel }).then(() => undefined, () => setRevealNotice(REVEAL_FAILED));
  }, [available]);
  const mermaid = useMemo(() => (available ? hostMermaidRuntime(invokeHost) : undefined), [available]);
  const onExport = useCallback(async (name: string, text: string) => {
    setExportNotice(null);
    try {
      const path = await invokeHost<string | null>("export_note", { name, text, title: "Export document" });
      // A cancelled native dialog is not an event worth a banner; only a real export gets one.
      if (path) setExportNotice({ kind: "ok", message: "Exported the document outside the project." });
    } catch {
      setExportNotice({ kind: "error", message: "The document could not be exported." });
    }
  }, []);
  const env = useMemo(() => ({
    reveal: available ? onReveal : undefined,
    fs: available ? deps.fs : null,
    notes: available ? deps.notes : null,
    readImage: available ? async (path: string) => {
      const raw = await invokeHost<unknown>("fs_read_image", { path });
      const o = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
      return typeof o.dataUrl === "string" ? o.dataUrl : null;
    } : undefined,
  }), [available, deps, onReveal]);
  const onOpenFile = useCallback((path: string) => {
    const rel = safeRelativePath(path);
    if (rel) shellBus.publish({ type: "open-file", path: rel });
  }, []);
  const onOpenSettings = useCallback(() => shellBus.publish({ type: "goto-section", section: "settings", anchor: "providers" }), []);
  return <DocGenScreen store={deps.store} env={env} active={active} projectRoot={projectRoot} onOpenFile={onOpenFile} onReveal={available ? onReveal : undefined} revealNotice={revealNotice} pickTemplateFile={available ? () => pickTemplateFile(invokeHost) : undefined} onOpenExternal={(u) => void openExternal(u)} onOpenSettings={onOpenSettings} mermaid={mermaid} onExport={available ? onExport : undefined} exportNotice={exportNotice} />;
}
