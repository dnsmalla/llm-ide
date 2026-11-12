import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ConnectionState } from "./host-api/connection.ts";
import { initialHostUrl } from "./host-api/url.ts";
import { lastHostUrl } from "./host-api/storage.ts";
import { chooseScreen, createAppModel, driveSync, hostUnreachable, syncShouldRun, type AppModel, type AppView, type Session } from "./app-model.ts";
import { createSyncController, type SyncController } from "./sync/controller.ts";
import { createSourcesController, type SourcesController } from "./sources/controller.ts";
import { SourcesEntry, SourcesScreen } from "./screens/SourcesScreen.tsx";
import { PairingScreen } from "./screens/PairingScreen.tsx";
import { WebChat } from "./screens/WebChat.tsx";
import { ComposeBar } from "./screens/ComposeBar.tsx";
import { ReadPanel } from "./screens/ReadPanel.tsx";
import { OfflineCopyEntry, SyncLinkEntry, SyncTier } from "./screens/SyncTier.tsx";
import { hubCopy, isHubHello, syncEntryVisible } from "./hub-copy.ts";
import { createPushController } from "./push/controller.ts";
import { PushToggle } from "./screens/PushToggle.tsx";

/** The session's connection state, re-rendered on every change. */
function useConnection(session: Session | null): ConnectionState | null {
  const [, bump] = useState(0);
  useEffect(() => session?.connection.onState(() => bump((n) => n + 1)), [session]);
  return session?.connection.state ?? null;
}

function Chat({ session, conn, onForget, onOpenOffline }: { session: Session; conn: ConnectionState; onForget: () => void; onOpenOffline?: () => void }) {
  const { connection: c, controller, read, compose, projects } = session;
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  const readState = useSyncExternalStore(read.subscribe, read.getState, read.getState);
  const cs = useSyncExternalStore(compose.subscribe, compose.getState, compose.getState);
  const projectState = useSyncExternalStore(projects.subscribe, projects.getState, projects.getState);
  const [push] = useState(() => createPushController(c));
  const ps = useSyncExternalStore(push.subscribe, push.getState, push.getState);
  useEffect(() => { void push.refresh(); return c.onResync(() => void push.refresh()); }, [push, c]);
  const capabilities = state.capabilities ?? c.capabilities;
  const canCompose = capabilities.has("compose");
  const send = (t: string) => {
    const sent = compose.getState().attachments;
    void controller.send(t, compose.extras()).then((ok) => { if (ok) compose.removeSent(sent); });
  };
  const newChat = () => void controller.newChat().then((ok) => { if (ok) void read.refresh(); });
  return (
    <div className="web-shell">
      <PushToggle state={ps} onEnable={() => void push.enable()} onDisable={() => void push.disable()} />
      <ReadPanel capabilities={capabilities} state={readState} onOpen={(id, t) => void read.open(id, t)}
        onOlder={() => void read.older()} onClose={read.close} onMore={() => void read.moreSessions()} />
      {!readState.open && (
        <WebChat hostName={c.hello?.hostName ?? "Host"} hostUrl={session.url} connection={conn} capabilities={capabilities} state={state}
          projects={projectState} onSelectProject={(id) => { projects.select(id); }}
          onSend={send} onStop={() => void controller.cancel()} onClear={() => void controller.clearHistory()}
          onForget={onForget} onOpenOffline={onOpenOffline} onAnswer={(r, a) => void controller.answerQuestion(r, a)} onDecline={(r) => void controller.declineQuestion(r)}
          onTool={(r, d) => void controller.answerTool(r, d)} onNewChat={canCompose ? newChat : undefined}
          compose={capabilities.has("chat") ? (
            <ComposeBar state={cs} canChoose={canCompose} disabled={conn.kind !== "ready" || state.turn !== null}
              onMode={compose.setMode} onModel={compose.setModel} onRemove={compose.remove}
              onFiles={(f) => { if (f) void compose.addFiles(Array.from(f)); }} />
          ) : null} />
      )}
    </div>
  );
}

export function App(props: { model?: AppModel; sync?: SyncController; sources?: SourcesController }) {
  const page = legalPage(globalThis.location?.pathname ?? "/");
  if (page) return <LegalPage page={page} />;
  return <AppMain {...props} />;
}

function AppMain({ model: given, sync: givenSync, sources: givenSources }: { model?: AppModel; sync?: SyncController; sources?: SourcesController }) {
  const [model] = useState(() => given ?? createAppModel(initialHostUrl(import.meta.env.VITE_HOST_API_URL, lastHostUrl().get())));
  const [sync] = useState(() => givenSync ?? createSyncController());
  const [sources] = useState(() => givenSources ?? createSourcesController());
  const [showSources, setShowSources] = useState(false);
  const [view, setView] = useState<AppView>("auto");
  const [liveSession, setLiveSession] = useState<Session | null>(null);
  const s = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const sy = useSyncExternalStore(sync.subscribe, sync.getState, sync.getState);
  const so = useSyncExternalStore(sources.subscribe, sources.getState, sources.getState);
  const conn = useConnection(s.session);
  const hub = isHubHello(s.session?.connection.hello);
  useEffect(() => { model.start(); return model.dispose; }, [model]);
  useEffect(() => sync.dispose, [sync]);
  useEffect(() => { void sources.start(); return sources.dispose; }, [sources]);
  const live = conn?.kind === "ready";
  useEffect(() => { if (live) { setLiveSession(s.session); setView((v) => (v === "host" ? "auto" : v)); } }, [live, s.session]);
  // A blip keeps Chat (and its draft) mounted; the first connection attempt is not "down" either: no sync-tier flash.
  const lastReconnect = useRef<ConnectionState | null>(null);
  if (conn?.kind === "reconnecting") lastReconnect.current = conn;
  else if (conn?.kind !== "connecting") lastReconnect.current = null;
  const down = hostUnreachable(conn, s.session !== null && liveSession === s.session, lastReconnect.current);
  const run = syncShouldRun({ hub, session: s.session !== null, busy: s.busy, down, view });
  useEffect(() => { driveSync(sync, { hub, run }); }, [sync, hub, run]);
  const openSources = () => setShowSources(true);
  if (showSources) return <SourcesScreen state={so} sources={sources} onBack={() => setShowSources(false)} />;
  const screen = chooseScreen({ hub, syncPhase: sy.phase, session: s.session !== null, down, view });
  if (screen === "sync") return <SyncTier state={sy} sync={sync} hostPaired={s.session !== null} onSources={openSources} onHost={() => setView("host")} />;
  const linked = !hub && sy.phase !== "none";
  if (s.session && conn) return <Chat session={s.session} conn={conn} onForget={model.forget} onOpenOffline={linked ? () => setView("sync") : undefined} />;
  return <PairingScreen initialUrl={model.initialUrl} busy={s.busy} error={s.error} revokedNotice={s.notice} onSubmit={(u, p) => void model.attempt(u, p)}
    footer={<>{!syncEntryVisible(s.session?.connection.hello) ? <p className="hub-note">{hubCopy(s.session?.connection.hello)}</p>
      : linked ? <OfflineCopyEntry onOpen={() => setView("sync")} />
      : <SyncLinkEntry onLink={sync.acceptLink} error={sy.phase === "none" ? sy.error : null} />}<SourcesEntry onOpen={openSources} /></>} />;
}

// ---- Legal pages (Apple review + support) -------------------------------------------------------

type LegalPage = "privacy" | "support";

function legalPage(path: string): LegalPage | null {
  const p = path.replace(/\/+$/, "");
  if (p === "/app/privacy" || p === "/privacy") return "privacy";
  if (p === "/app/support" || p === "/support") return "support";
  return null;
}

const SUPPORT_EMAIL = "support@llm-ide.com";

function LegalPage({ page }: { page: LegalPage }) {
  const privacy = page === "privacy";
  useEffect(() => {
    const prev = document.title;
    document.title = privacy ? "Privacy Policy · LLM-IDE" : "Support · LLM-IDE";
    return () => { document.title = prev; };
  }, [privacy]);
  return (
    <main className="web-legal">
      <header className="web-legal-bar">
        <a className="web-brand" href="/app/" aria-label="LLM-IDE app">
          <span className="web-mark" aria-hidden="true" /><span>LLM-IDE</span><em>web</em>
        </a>
        <nav className="web-legal-nav" aria-label="Legal and support">
          <a href="/app/privacy" aria-current={privacy ? "page" : undefined}>Privacy</a>
          <a href="/app/support" aria-current={!privacy ? "page" : undefined}>Support</a>
          <a href="/app/">Open app</a>
        </nav>
      </header>
      <article className="web-legal-card">
        <p className="web-kicker">{privacy ? "Privacy" : "Support"}</p>
        <h1>{privacy ? "Privacy Policy" : "Support"}</h1>
        <p className="web-legal-updated">Last updated: 7 November 2026</p>
        {privacy ? <PrivacyBody /> : <SupportBody />}
      </article>
      <footer className="web-foot"><span>LLM-IDE · local-first</span><span><a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a></span></footer>
    </main>
  );
}

function PrivacyBody() {
  return (
    <div className="web-legal-body">
      <p>LLM-IDE is a local-first developer tool. This policy explains what the web app at <strong>llm-ide.com/app</strong> does with data. It covers the web app; the desktop and iPhone apps have their own settings and stores.</p>

      <h2>No LLM-IDE account</h2>
      <p>We do not operate a user account service for the app. You do not create an account with us, and we do not receive your chats, project files, meeting notes, prompts, model keys or sync passwords.</p>

      <h2>Data kept in your browser</h2>
      <ul>
        <li><strong>Host address and device token</strong> are kept in this browser's local storage so it can reconnect to the desktop you paired. <strong>Forget this host</strong> removes them.</li>
        <li><strong>Offline-sync identity and keys</strong> are kept in this browser's IndexedDB. Private keys are generated as non-extractable browser keys. They are not sent to us.</li>
        <li>If you clear this site's data or use a private window, that local state is removed when the browser discards it.</li>
      </ul>

      <h2>Direct connections</h2>
      <p>When you pair, the browser connects directly to the address you enter, normally your own computer running the LLM-IDE desktop app. Chat messages, approvals, project data and model requests travel over that connection. They do not pass through an LLM-IDE server.</p>

      <h2>Optional offline sync</h2>
      <p>If you turn on offline sync, the desktop encrypts a snapshot before uploading it to storage you choose: MEGA, Box, or your own server. We do not operate or control that storage and cannot decrypt the snapshot. The storage provider's own privacy policy applies to the encrypted files and connection metadata.</p>

      <h2>Optional Box and GitLab reads</h2>
      <p>If you connect Box or GitLab, the browser talks to those providers directly with the credentials or OAuth tokens you provide. We do not receive those tokens or the documents read from them.</p>

      <h2>Website logs</h2>
      <p>The static site is served by a web server that may keep standard operational logs such as IP address, user agent, time and requested URL for security and capacity. Those logs do not contain chat text, project content, pairing PINs or sync keys. We do not use advertising cookies or cross-site tracking, and we do not sell data.</p>

      <h2>Children</h2>
      <p>The app is a developer tool and is not directed at children under 13.</p>

      <h2>Changes and contact</h2>
      <p>If this policy changes, the date above changes with it. Questions: <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.</p>
    </div>
  );
}

function SupportBody() {
  return (
    <div className="web-legal-body">
      <p>LLM-IDE runs on your own computer. Most problems are a pairing address, a desktop that is not running, or a browser that has not been allowed on the desktop.</p>

      <h2>Pair the browser</h2>
      <ol>
        <li>Open the LLM-IDE desktop app and keep it running.</li>
        <li>Go to <strong>Settings → Host API pairing</strong> and choose <strong>Show PIN</strong>.</li>
        <li>Enter the host address and the six-digit PIN at <a href="/app/">llm-ide.com/app</a>.</li>
        <li>If the desktop lists allowed web origins, add this page's address there before pairing.</li>
      </ol>

      <h2>Offline sync</h2>
      <p>If the desktop is off, the browser can read the last encrypted snapshot and queue prompts. In Settings → Sync, add a browser and open the generated sync link here. The MEGA password is used once to unlock; the session is not kept after the page reloads.</p>

      <h2>Common fixes</h2>
      <ul>
        <li><strong>“Could not reach the host”</strong> — check the desktop is running, the address is exact, and both devices are on the same network.</li>
        <li><strong>“Pairing failed”</strong> — the PIN expires; request a new one. Check the web origin is allowed on the desktop.</li>
        <li><strong>Sync locked after reload</strong> — enter the MEGA password again; this is deliberate and the password is never stored.</li>
        <li><strong>Remove this browser</strong> — use <strong>Forget this host</strong> in the app, or clear site data in the browser.</li>
      </ul>

      <h2>Contact</h2>
      <p>Email <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>. Include the browser, operating system, what you expected and the exact message shown. Never send a pairing PIN, sync password, API key or chat content.</p>
      <p className="web-legal-actions"><a className="web-legal-button" href="/app/">Open the app</a><a className="web-legal-button web-legal-button-quiet" href="/app/privacy">Privacy policy</a></p>
    </div>
  );
}
