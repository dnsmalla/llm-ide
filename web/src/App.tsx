import { useEffect, useState, useSyncExternalStore } from "react";
import type { ConnectionState } from "./host-api/connection.ts";
import { initialHostUrl } from "./host-api/url.ts";
import { lastHostUrl } from "./host-api/storage.ts";
import { createAppModel, type AppModel, type Session } from "./app-model.ts";
import { PairingScreen } from "./screens/PairingScreen.tsx";
import { WebChat } from "./screens/WebChat.tsx";
import { ReadPanel } from "./screens/ReadPanel.tsx";

function Chat({ session, onForget }: { session: Session; onForget: () => void }) {
  const { connection: c, controller, read } = session;
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  const readState = useSyncExternalStore(read.subscribe, read.getState, read.getState);
  const [conn, setConn] = useState<ConnectionState>(c.state);
  useEffect(() => c.onState(setConn), [c]);
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

export function App({ model: given }: { model?: AppModel }) {
  const [model] = useState(() => given ?? createAppModel(initialHostUrl(import.meta.env.VITE_HOST_API_URL, lastHostUrl().get())));
  const s = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  useEffect(() => { model.start(); return model.dispose; }, [model]);
  if (s.session) return <Chat session={s.session} onForget={model.forget} />;
  return <PairingScreen initialUrl={model.initialUrl} busy={s.busy} error={s.error} revokedNotice={s.notice} onSubmit={(u, p) => void model.attempt(u, p)} />;
}
