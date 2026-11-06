import { useEffect, useState, useSyncExternalStore } from "react";
import type { ConnectionState } from "./host-api/connection.ts";
import { initialHostUrl } from "./host-api/url.ts";
import { lastHostUrl } from "./host-api/storage.ts";
import { createAppModel, type AppModel, type Session } from "./app-model.ts";
import { createSyncController, type SyncController } from "./sync/controller.ts";
import { createSourcesController, type SourcesController } from "./sources/controller.ts";
import { SourcesEntry, SourcesScreen } from "./screens/SourcesScreen.tsx";
import { PairingScreen } from "./screens/PairingScreen.tsx";
import { WebChat } from "./screens/WebChat.tsx";
import { ReadPanel } from "./screens/ReadPanel.tsx";
import { SyncLinkEntry, SyncTier } from "./screens/SyncTier.tsx";

/** The session's connection state, re-rendered on every change. */
function useConnection(session: Session | null): ConnectionState | null {
  const [, bump] = useState(0);
  useEffect(() => session?.connection.onState(() => bump((n) => n + 1)), [session]);
  return session?.connection.state ?? null;
}

function Chat({ session, conn, onForget }: { session: Session; conn: ConnectionState; onForget: () => void }) {
  const { connection: c, controller, read } = session;
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  const readState = useSyncExternalStore(read.subscribe, read.getState, read.getState);
  const capabilities = state.capabilities ?? c.capabilities;
  return (
    <div className="web-shell">
      <ReadPanel capabilities={capabilities} state={readState} onOpen={(id, t) => void read.open(id, t)}
        onOlder={() => void read.older()} onClose={read.close} onMore={() => void read.moreSessions()} />
      {!readState.open && (
        <WebChat hostName={c.hello?.hostName ?? "Host"} connection={conn} capabilities={capabilities} state={state}
          onSend={(t) => void controller.send(t)} onStop={() => void controller.cancel()} onClear={() => void controller.clearHistory()}
          onForget={onForget} onAnswer={(r, a) => void controller.answerQuestion(r, a)} onDecline={(r) => void controller.declineQuestion(r)}
          onTool={(r, d) => void controller.answerTool(r, d)} />
      )}
    </div>
  );
}

export function App({ model: given, sync: givenSync, sources: givenSources }: { model?: AppModel; sync?: SyncController; sources?: SourcesController }) {
  const [model] = useState(() => given ?? createAppModel(initialHostUrl(import.meta.env.VITE_HOST_API_URL, lastHostUrl().get())));
  const [sync] = useState(() => givenSync ?? createSyncController());
  const [sources] = useState(() => givenSources ?? createSourcesController());
  const [showSources, setShowSources] = useState(false);
  const s = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const sy = useSyncExternalStore(sync.subscribe, sync.getState, sync.getState);
  const so = useSyncExternalStore(sources.subscribe, sources.getState, sources.getState);
  const conn = useConnection(s.session);
  useEffect(() => { model.start(); return model.dispose; }, [model]);
  useEffect(() => { void sync.start(); return sync.dispose; }, [sync]);
  useEffect(() => { void sources.start(); return sources.dispose; }, [sources]);
  const live = conn?.kind === "ready";
  useEffect(() => { if (live) sync.pause(); else sync.resume(); }, [live, sync]);
  // While the first connection attempt is still running the host is not "down" yet: no sync-tier flash before chat.
  const hostDown = (!s.session && !s.busy) || conn?.kind === "reconnecting" || conn?.kind === "failed";
  const openSources = () => setShowSources(true);
  if (showSources) return <SourcesScreen state={so} sources={sources} onBack={() => setShowSources(false)} />;
  if (sy.phase === "pairing" || (sy.phase !== "none" && hostDown)) return <SyncTier state={sy} sync={sync} hostPaired={s.session !== null} onSources={openSources} />;
  if (s.session && conn) return <Chat session={s.session} conn={conn} onForget={model.forget} />;
  return <PairingScreen initialUrl={model.initialUrl} busy={s.busy} error={s.error} revokedNotice={s.notice} onSubmit={(u, p) => void model.attempt(u, p)}
    footer={<><SyncLinkEntry onLink={sync.acceptLink} error={sy.phase === "none" ? sy.error : null} /><SourcesEntry onOpen={openSources} /></>} />;
}
