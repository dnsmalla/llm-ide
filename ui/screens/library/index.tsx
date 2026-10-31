// Library section entry: the shell lazy-loads this module (default export, SectionProps) and keeps it
// mounted while other sections are shown, so the loaded list, selection and filters survive switches.
//
// Read side only (S-E). The write side (S-I) and the Extensions panes (S-J) plug in through
// `LibraryScreenProps.extensions` and, later, extra props; this file is where they are wired.
import "@llmide/ui-kit/styles.css";
import "./library.css";
import { useCallback, useMemo } from "react";
import { core as shellCore, host as shellHost, invokeHost } from "@llmide/screens/shell";
import type { SectionProps } from "@llmide/screens/shell";
import { indexCoreFrom, searchCoreFrom } from "./core-adapter.ts";
import { createNotesHost } from "./host.ts";
import { rebuildIndex } from "./index-rebuild.ts";
import { LibraryStore } from "./library-store.ts";
import { makeSearchRun } from "./search.ts";
import { LibraryScreen } from "./LibraryScreen";

export { LibraryScreen, type LibraryScreenProps } from "./LibraryScreen";
export { EXTENSION_PLACEHOLDERS, type LibraryExtension } from "./LibraryNav";
export { LibraryStore } from "./library-store.ts";

/** One store for the app: the shell keeps this screen mounted, so there is nothing to dispose. */
let singleton: { store: LibraryStore; host: ReturnType<typeof createNotesHost> } | null = null;

function app(): NonNullable<typeof singleton> {
  if (!singleton) {
    const host = createNotesHost((cmd, args) => invokeHost(cmd, args));
    singleton = { host, store: new LibraryStore({ host, searchRun: makeSearchRun(searchCoreFrom(shellCore)) }) };
  }
  return singleton;
}

/** Opens an allowlisted URL through the host. The host command is not in the Rust host yet (blocked-by, see the
 *  parity checklist): until it lands the click shows a notice instead of navigating the webview. */
async function openExternal(url: string): Promise<void> {
  if (!shellHost.isAvailable()) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  await invokeHost("open_external_url", { url });
}

export default function Library({ active }: SectionProps) {
  const { store, host } = useMemo(app, []);
  const runRebuild = useCallback(
    (records: Parameters<typeof rebuildIndex>[0], report: Parameters<typeof rebuildIndex>[2], signal: AbortSignal) =>
      rebuildIndex(records, { host, core: indexCoreFrom(shellCore) }, report, signal),
    [host],
  );
  return <LibraryScreen store={store} host={host} runRebuild={runRebuild} onOpenExternal={openExternal} active={active} hostAvailable={shellHost.isAvailable()} />;
}
