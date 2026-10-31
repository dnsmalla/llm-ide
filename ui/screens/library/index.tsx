// Library section entry: the shell lazy-loads this module (default export, SectionProps) and keeps it
// mounted while other sections are shown, so the loaded list, selection and filters survive switches.
//
// Read side (S-E), write side + Connections panes (S-I) and the Extensions panes (S-J) are wired here:
// `write` and `connections` exist only inside the desktop app; `extensions` is S-J's.
import "@llmide/ui-kit/styles.css";
import "./library.css";
import "./write/write.css";
import { useCallback, useMemo } from "react";
import { core as shellCore, host as shellHost, invokeHost } from "@llmide/screens/shell";
import type { SectionProps } from "@llmide/screens/shell";
import { indexCoreFrom, searchCoreFrom } from "./core-adapter.ts";
import { createNotesHost } from "./host.ts";
import { rebuildIndex } from "./index-rebuild.ts";
import { LibraryStore } from "./library-store.ts";
import { makeSearchRun } from "./search.ts";
import { LibraryScreen } from "./LibraryScreen";
import { EXTENSION_PLACEHOLDERS } from "./LibraryNav";
import { libraryExtensions } from "./extensions/index.tsx";
import { sourcesCoreFrom, summarizeCoreFrom } from "./sources/adapter.ts";
import { withCreatedHook } from "./sources/created-hook.ts";
import { sourceConnections } from "./sources/SourcePanes";
import { createWriteHost } from "./write/write-host.ts";

export { LibraryScreen, type LibraryScreenProps } from "./LibraryScreen";
export { EXTENSION_PLACEHOLDERS, type LibraryExtension } from "./LibraryNav";
import { publicHttpsUrl } from "./safe-url.ts";
export { LibraryStore } from "./library-store.ts";

/** One store for the app: the shell keeps this screen mounted, so there is nothing to dispose. */
let singleton: { store: LibraryStore; host: ReturnType<typeof createNotesHost>; writeHost: ReturnType<typeof createWriteHost> } | null = null;

function app(): NonNullable<typeof singleton> {
  if (!singleton) {
    const host = createNotesHost((cmd, args) => invokeHost(cmd, args));
    singleton = { host, writeHost: createWriteHost((cmd, args) => invokeHost(cmd, args)), store: new LibraryStore({ host, searchRun: makeSearchRun(searchCoreFrom(shellCore)) }) };
  }
  return singleton;
}

/** Opens an allowlisted URL through the host. The host command is not in the Rust host yet (blocked-by, see the
 *  parity checklist): until it lands the click shows a notice instead of navigating the webview. */
async function openExternal(url: string): Promise<void> {
  if (!shellHost.isAvailable()) {
    const safe = publicHttpsUrl(url);
    if (safe) window.open(safe, "_blank", "noopener,noreferrer");
    return;
  }
  await invokeHost("open_external_url", { url });
}

export default function Library({ active }: SectionProps) {
  const { store, host, writeHost } = useMemo(app, []);
  const runRebuild = useCallback(
    (records: Parameters<typeof rebuildIndex>[0], report: Parameters<typeof rebuildIndex>[2], signal: AbortSignal) =>
      rebuildIndex(records, { host, core: indexCoreFrom(shellCore) }, report, signal),
    [host],
  );
  const extensions = useMemo(() => libraryExtensions(shellCore, EXTENSION_PLACEHOLDERS), []);
  // The write side exists only inside the desktop app (it needs the notes_write host commands).
  const available = shellHost.isAvailable();
  const write = useMemo(() => (available ? { host: writeHost, summarize: summarizeCoreFrom(shellCore) } : null), [available, writeHost]);
  const connections = useMemo(
    () =>
      available
        ? sourceConnections({
            core: sourcesCoreFrom(shellCore),
            write: withCreatedHook(writeHost, (saved, text) => store.noteWritten(saved, text)),
            openExternal,
            pickFolder: async () => {
              const r = await invokeHost<{ path: string; name: string } | null>("source_pick_folder");
              return r && typeof r.path === "string" ? { path: r.path, name: typeof r.name === "string" ? r.name : "" } : null;
            },
          })
        : undefined,
    [available, writeHost, store],
  );
  return <LibraryScreen store={store} host={host} write={write} connections={connections} runRebuild={runRebuild} onOpenExternal={openExternal} extensions={extensions} active={active} hostAvailable={available} />;
}
