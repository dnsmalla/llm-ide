import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { HostApiError, HostConnection, type ConnectionState } from "./host-api/connection.ts";
import { initialHostUrl } from "./host-api/url.ts";
import { lastHostUrl, tokenStoreFor } from "./host-api/storage.ts";
import { createChatController, type ChatController } from "./chat/controller.ts";
import { PairingScreen } from "./screens/PairingScreen.tsx";
import { WebChat } from "./screens/WebChat.tsx";

interface Session { url: string; connection: HostConnection; controller: ChatController }
const REVOKED = "This browser's pairing was revoked or expired. Enter a new PIN.";

function open(url: string): Session {
  const connection = new HostConnection({ url, clientName: "LLM-IDE Web", clientVersion: __APP_VERSION__, tokens: tokenStoreFor(url) });
  return { url, connection, controller: createChatController(connection) };
}
const shut = (s: Session) => { s.controller.dispose(); s.connection.close(); };

function Chat({ session, onForget }: { session: Session; onForget: () => void }) {
  const { connection: c, controller } = session;
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const [conn, setConn] = useState<ConnectionState>(c.state);
  useEffect(() => c.onState(setConn), [c]);
  return (
    <WebChat hostName={c.hello?.hostName ?? "Host"} connection={conn} capabilities={state.capabilities ?? c.capabilities} state={state}
      onSend={(t) => void controller.send(t)} onStop={() => void controller.cancel()} onClear={() => void controller.clearHistory()}
      onForget={onForget} onAnswer={(r, a) => void controller.answerQuestion(r, a)} onDecline={(r) => void controller.declineQuestion(r)}
      onTool={(r, d) => void controller.answerTool(r, d)} />
  );
}

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const live = useRef<Session | null>(null);
  const [initialUrl] = useState(() => initialHostUrl(import.meta.env.VITE_HOST_API_URL, lastHostUrl().get()));

  const adopt = (s: Session | null) => { if (live.current && live.current !== s) shut(live.current); live.current = s; setSession(s); };

  const attempt = async (url: string, pin?: string) => {
    const s = open(url);
    live.current = s; // so unmount closes it mid-connect
    setBusy(true); setError(null);
    try {
      if ((await s.connection.connect(pin)) === "ready") { lastHostUrl().set(url); adopt(s); setNotice(null); }
      else { shut(s); live.current = null; setNotice(REVOKED); }
    } catch (e) {
      shut(s); live.current = null;
      setError(e instanceof HostApiError && e.code === "auth_failed" ? "Wrong or expired PIN. Show a new one in the desktop app's Settings." : e instanceof Error ? e.message : "Could not connect.");
    } finally { setBusy(false); }
  };

  useEffect(() => {
    if (tokenStoreFor(initialUrl).get()) void attempt(initialUrl);
    return () => { if (live.current) shut(live.current); live.current = null; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (session) {
    return <Chat session={session} onForget={() => {
      void session.connection.forget().then((revoked) => {
        setNotice(revoked ? null : "Revoke this browser in the desktop app's Settings as well.");
        adopt(null);
      });
    }} />;
  }
  return <PairingScreen initialUrl={initialUrl} busy={busy} error={error} revokedNotice={notice} onSubmit={(u, p) => void attempt(u, p)} />;
}
