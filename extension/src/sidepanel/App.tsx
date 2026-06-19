import React, { useState, useEffect, useCallback } from 'react';
import { useTranscript } from './hooks/useTranscript';
import { useLiveSync } from './hooks/useLiveSync';
import { useNotes } from './hooks/useNotes';
import { useAudioDevices } from './hooks/useAudioDevices';
import { useChat } from './hooks/useChat';
import { useQuestions } from './hooks/useQuestions';
// `usePlan` is kept (the agent toggle bar uses it for stub creation
// + inline rename), but the entity / dispatch / review / notify /
// outcomes hooks aren't needed in the trimmed-down extension — the
// Mac app owns those flows.
import { usePlan } from './hooks/usePlan';
import { useSession } from './hooks/useSession';
import { getServerUrl, HEALTH_CHECK_TIMEOUT_MS, TIMING } from '../lib/config';
import RecordingControls from './components/RecordingControls';
import { useAgent } from './hooks/useAgent';
import { useAgentMirror } from './hooks/useAgentMirror';
import { useRemoteSessions, RemoteSession } from './hooks/useRemoteSessions';
import { useRemoteTranscript } from './hooks/useRemoteTranscript';
import LanguageSelector from './components/LanguageSelector';
import TranscriptView from './components/TranscriptView';
import RemoteSessionBanner from './components/RemoteSessionBanner';
import NotesView from './components/NotesView';
import ExportMenu from './components/ExportMenu';
import ChatView from './components/ChatView';
import Settings from './components/Settings';
import QuestionsView from './components/QuestionsView';
import LoginView from './components/LoginView';
import HelpPanel from './components/HelpPanel';

// Trimmed tab set.  Actions / Plan / Review were moved out of the
// extension and into the Mac app — they're project-management
// surfaces that benefit from a bigger window and don't belong in a
// 280-px-wide side panel.  The extension stays focused on capture
// (Transcript), the AI surface that operates on it (Notes, Questions,
// Chat), and the supporting bits (History, Settings).
type Tab = 'transcript' | 'notes' | 'questions' | 'chat' | 'settings';

const TABS: { id: Tab; label: string }[] = [
  { id: 'transcript', label: 'Transcript' },
  { id: 'notes', label: 'Notes' },
  { id: 'questions', label: 'Questions' },
  { id: 'chat', label: 'Chat' },
  { id: 'settings', label: 'Settings' },
];

function formatDuration(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

const HINT_DISMISSED_KEY = 'firstRunHintDismissed';

// Client-expected endpoints.  If the server's /health response doesn't list
// every one of these, it's almost certainly a stale `node server.mjs`
// process from before a client update — the UI surfaces a dedicated
// "restart the server" banner instead of letting the user hit a bare 404.
const REQUIRED_ENDPOINTS = [
  '/generate-notes',
  '/generate-docx',
  '/chat',
  '/generate-questions',
  '/extract-entities',
  '/kb/ingest',
  '/kb/search',
  '/kb/connect-git',
  '/kb/generate-plan',
  '/kb/dispatch',
  '/kb/generate-code',
  '/kb/review/submit',
  '/kb/review/list',
  '/kb/review/approve',
  '/kb/notify/slack',
  '/kb/outcomes/refresh',
];

export default function App() {
  // Auth gate is the very first hook so login renders before any of the
  // other tabs hit the server.  Their hooks still run unconditionally
  // (Rules of Hooks), but they make no requests until the access token
  // exists — getServerUrl + authFetch see a null token and any /kb/*
  // call is a no-op until the user logs in.
  const sess = useSession();

  const [activeTab, setActiveTab] = useState<Tab>('transcript');
  const [serverOnline, setServerOnline] = useState(false);

  // Alt+1–6 keyboard shortcuts for tab navigation.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      const num = parseInt(e.key, 10);
      if (num >= 1 && num <= TABS.length) {
        e.preventDefault();
        setActiveTab(TABS[num - 1].id);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);
  const [serverStale, setServerStale] = useState<string[] | null>(null);
  const [saveFeedback, setSaveFeedback] = useState(false);
  const [copyCmdFeedback, setCopyCmdFeedback] = useState(false);
  const [showHint, setShowHint] = useState(false);
  // Session-scoped meeting id — set on Start, reused for KB ingest so
  // re-extracting on the same recording updates the same KB row.
  const [sessionId, setSessionId] = useState<string>(() => {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    const rand = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return `m-${Date.now().toString(36)}-${rand}`;
  });
  const [isMirroring, setIsMirroring] = useState(false);
  const [discoveryDismissed, setDiscoveryDismissed] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  useEffect(() => {
    chrome.storage?.local
      ?.get(HINT_DISMISSED_KEY)
      .then((r) => {
        if (!r?.[HINT_DISMISSED_KEY]) setShowHint(true);
      })
      .catch(() => {});
  }, []);

  const dismissHint = useCallback(() => {
    setShowHint(false);
    chrome.storage?.local?.set({ [HINT_DISMISSED_KEY]: true }).catch(() => {});
  }, []);

  const transcript = useTranscript();
  // Mirror the live transcript to the backend so other clients
  // (Mac desktop app) can show it in real time.  Fire-and-forget;
  // failure here doesn't affect the local capture or the canonical
  // /kb/ingest finalize path.
  const liveSync = useLiveSync({
    isRecording: transcript.isRecording,
    sessionId,
    meetingTitle: transcript.meetingTitle,
    segments: transcript.segments,
  });
  const notes = useNotes();
  const audio = useAudioDevices();
  const chat = useChat();
  const questions = useQuestions();
  const plan = usePlan();
  const agent = useAgent({
    isRecording: transcript.isRecording,
    language: transcript.primaryLang,
    sessionId,
  });
  // User-controlled on/off for the AI assistant.  Default is ON so
  // recording a meeting auto-attaches the agent (the new behavior the
  // user asked for — no more "Send agent" pill in the header).  The
  // toggle lives inside the Questions tab; flipping it OFF detaches
  // any running run AND prevents auto-attach on future recordings.
  const [agentEnabled, setAgentEnabled] = useState<boolean>(() => {
    try {
      return localStorage.getItem('agent.enabled') !== '0';
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('agent.enabled', agentEnabled ? '1' : '0');
    } catch {
      /* */
    }
  }, [agentEnabled]);
  // Auto-stub a plan the first time the user records without one.
  // The stub has a generic name (renameable inline below) and an
  // empty task list — enough to satisfy the agent's "no plan
  // attached" gate so it can start drafting.  Once the user runs
  // /kb/generate-plan from a real transcript, that becomes the
  // active plan and the stub stays in History under its generic
  // name (or whatever the user renamed it to).
  useEffect(() => {
    if (!agentEnabled) return;
    if (!transcript.isRecording) return;
    if (plan.plan) return; // already have a plan
    plan.createStub({ language: transcript.primaryLang });
    // deps intentionally narrow (see comments) — only react to these transitions
  }, [agentEnabled, transcript.isRecording]);

  // Auto-attach: when recording starts AND there's an active plan,
  // dispatch a single run.  With the stub above, this fires on
  // virtually every recording — the user gets a working agent out
  // of the box with no manual setup.
  useEffect(() => {
    if (!agentEnabled) return;
    if (!transcript.isRecording) return;
    if (agent.runs.length > 0) return;
    if (agent.busy) return;
    const planId = plan.plan?.id ?? null;
    if (!planId) return; // wait for createStub to complete
    agent.dispatch(planId);
    // We intentionally omit `agent` from deps to avoid re-firing on
    // every busy/error tick — we only react to (recording, planId,
    // enabled) transitions.
  }, [transcript.isRecording, agentEnabled, plan.plan?.id, agent.runs.length]);
  // Flipping the toggle OFF mid-meeting detaches any active run so
  // the agent stops drafting questions immediately.
  useEffect(() => {
    if (agentEnabled) return;
    for (const r of agent.runs) agent.stop(r.sessionId);
    // deps intentionally narrow — only the toggle transition matters here
  }, [agentEnabled]);
  // Mirror agent contributions from /kb/live/<sessionId> into the
  // transcript view.  Only polls while at least one run is attached.
  const agentMirror = useAgentMirror({
    sessionId,
    isAttached: agent.runs.length > 0,
  });

  // Cross-client session discovery and mirroring.
  const discovery = useRemoteSessions();
  const mirror = useRemoteTranscript({
    sessionId,
    isMirroring,
  });

  const handleJoin = useCallback((session: RemoteSession) => {
    setIsMirroring(true);
    setSessionId(session.sessionId);
    setActiveTab('transcript');
    setDiscoveryDismissed(true);
  }, []);

  const handleStopMirroring = useCallback(() => {
    setIsMirroring(false);
  }, []);
  // Dispatch / codegen / review / outcome flows live in the Mac app
  // now — the extension just captures and supports the AI surfaces
  // (notes, agent questions, chat).

  const checkServer = useCallback(async () => {
    try {
      const url = await getServerUrl();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
      const response = await fetch(`${url}/`, { signal: controller.signal });
      clearTimeout(timeout);
      setServerOnline(response.ok);

      // Parse the capability list.  Older servers don't return `endpoints`
      // — we treat "no endpoints field at all" as also stale, because
      // that means the running process predates the capability probe.
      if (response.ok) {
        try {
          const health = await response.json();
          const reported: string[] = Array.isArray(health?.endpoints) ? health.endpoints : [];
          const missing = REQUIRED_ENDPOINTS.filter((e) => !reported.includes(e));
          setServerStale(reported.length === 0 || missing.length > 0 ? missing : null);
        } catch {
          setServerStale(REQUIRED_ENDPOINTS);
        }
      }
    } catch {
      setServerOnline(false);
      setServerStale(null);
    }
  }, []);

  useEffect(() => {
    checkServer();
    const interval = setInterval(checkServer, TIMING.SERVER_HEALTH_CHECK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [checkServer]);

  const handleStart = useCallback(() => {
    notes.clearNotes();
    chat.clearChat();
    questions.clearQuestions();
    plan.clearPlan();
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    const rand = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    setSessionId(`m-${Date.now().toString(36)}-${rand}`);
    setIsMirroring(false);
    transcript.startRecording({
      deviceId: audio.selectedDeviceId,
      volume: audio.volume,
    });
  }, [notes, chat, questions, plan, transcript, audio.selectedDeviceId, audio.volume]);

  const saveTranscript = useCallback(() => {
    if (!transcript.segments.length) return;
    const date = new Date().toISOString().split('T')[0];
    const duration = formatDuration(transcript.elapsed);

    const lines = [
      'LLM IDE — Transcript',
      `Date: ${date}`,
      `Duration: ${duration}`,
      '',
      ...transcript.segments.map((s) => {
        const name = transcript.speakerNames[s.speaker] || s.speaker;
        const time = new Date(s.timestamp).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        });
        return `[${time}] ${name}: ${s.text}`;
      }),
    ];

    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `transcript-${date}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);

    setSaveFeedback(true);
    setTimeout(() => setSaveFeedback(false), 2000);
  }, [transcript.segments, transcript.speakerNames, transcript.elapsed]);

  const subtitle = isMirroring
    ? 'Mirroring from another device'
    : transcript.isRecording
      ? transcript.captureMode === 'captions'
        ? 'Using platform captions (CC)'
        : `Microphone mode${transcript.bilingual ? ' · bilingual' : ''}`
      : 'Google Meet, Teams, Zoom & more';

  // Hand the transcript off to the LLM IDE desktop app via its
  // registered `llmide://` URL scheme.
  //
  // We *route through the local backend* rather than firing the
  // custom scheme directly from the side panel.  Reason: Chrome MV3
  // strips user-gesture context on cross-tab navigations, and JS-
  // driven location.href to a non-http(s) URL from a chrome-extension://
  // origin is silently dropped.  A server-side 302 from a regular
  // http origin (the local backend at 127.0.0.1:3456) bypasses both
  // restrictions — the URL bar's own navigation engine asks the OS
  // to handle the redirect, exactly like clicking a `slack://` link
  // works in any normal browser tab.
  //
  // /launch-app accepts ?to=<tab>&session=<id> so we can deep-link
  // any tab and (later) attach a live-session subscription.
  const popOut = useCallback(async () => {
    const serverUrl = await getServerUrl();
    const url = `${serverUrl}/launch-app?to=transcript`;
    chrome.tabs.create({ url });
  }, []);

  // ---- Auth gate ----------------------------------------------------
  // Boot phase: while the persisted refresh token is being exchanged
  // for a fresh access token, render a one-line splash so the user
  // doesn't see a flash of the login screen.
  if (sess.loading) {
    return (
      <div className="app login-loading">
        <p>Connecting to LLM IDE…</p>
      </div>
    );
  }
  if (!sess.authenticated) {
    return (
      <LoginView
        onLogin={sess.login}
        onRegister={sess.register}
        busy={sess.busy}
        error={sess.error}
        registrationOpen={sess.registrationOpen}
      />
    );
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-row">
          <h1>LLM IDE</h1>
          <span className="header-user" title={sess.user?.email}>
            {sess.user?.displayName || sess.user?.email || ''}
            {sess.user?.role === 'admin' && <span className="meta-chip role-admin">admin</span>}
          </span>
          <button
            className="btn-help"
            onClick={() => setShowHelp(true)}
            title="Help & getting started"
            aria-label="Open help guide"
          >
            ?
          </button>
          <button
            className="btn-popout"
            onClick={sess.logout}
            title={`Sign out ${sess.user?.email || ''}`.trim()}
            aria-label="Sign out"
          >
            ⎋
          </button>
          <button
            className="btn-popout"
            onClick={popOut}
            title="Open transcript in the LLM IDE desktop app"
            aria-label="Open transcript in the LLM IDE desktop app"
          >
            ↗
          </button>
        </div>
        <p className="meeting-subtitle">{subtitle}</p>
        {!isMirroring && !transcript.isRecording && !discoveryDismissed && (
          <RemoteSessionBanner
            sessions={discovery.sessions}
            onJoin={handleJoin}
            onDismiss={() => setDiscoveryDismissed(true)}
          />
        )}
      </header>

      <div className="controls-row">
        <RecordingControls
          isRecording={transcript.isRecording}
          isMirroring={isMirroring}
          elapsed={isMirroring ? 0 : transcript.elapsed}
          onStart={handleStart}
          onStop={isMirroring ? handleStopMirroring : transcript.stopRecording}
        />
        <LanguageSelector
          primaryLang={transcript.primaryLang}
          secondaryLang={transcript.secondaryLang}
          bilingual={transcript.bilingual}
          onChangePrimary={transcript.changePrimaryLang}
          onChangeSecondary={transcript.changeSecondaryLang}
          onToggleBilingual={transcript.toggleBilingual}
        />
      </div>

      {transcript.error && (
        <div className="error-message" role="alert">
          {transcript.error}
        </div>
      )}

      {transcript.saveError && (
        <div className="error-message" role="alert">
          {transcript.saveError}
        </div>
      )}

      {transcript.segmentLimitReached && (
        <div className="quota-warning" role="alert">
          Transcript limit reached (5,000 segments). Oldest lines are being dropped. Save your transcript to preserve
          it.
        </div>
      )}

      {liveSync.syncStatus === 'error' && transcript.isRecording && (
        <div className="quota-warning sync-warning" role="status">
          <span>
            Live sync paused — server unreachable ({liveSync.consecutiveFailures} failed attempts). Recording continues
            locally.
          </span>
          <button className="btn btn-sm" onClick={liveSync.resetSyncError} aria-label="Retry live sync">
            Retry
          </button>
        </div>
      )}

      {serverOnline && serverStale && (
        <div className="error-message server-offline" role="alert">
          <span>
            Server needs to be restarted to enable new features. Please stop and re-run <code>node server.mjs</code>.
          </span>
          <div className="server-offline-actions">
            <button className="btn btn-sm" onClick={checkServer} aria-label="Re-check server after restarting it">
              Re-check
            </button>
          </div>
        </div>
      )}

      {!serverOnline && (
        <div className="error-message server-offline" role="alert">
          <span>
            Can't reach the local server. Make sure <code>node server.mjs</code> is running.
          </span>
          <div className="server-offline-actions">
            <button
              className="btn btn-sm"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText('node server.mjs');
                  setCopyCmdFeedback(true);
                  setTimeout(() => setCopyCmdFeedback(false), 2000);
                } catch {
                  // Ignore — clipboard can fail in a non-secure context.
                }
              }}
              aria-label="Copy the server start command to clipboard"
            >
              {copyCmdFeedback ? 'Copied!' : 'Copy cmd'}
            </button>
            <button className="btn btn-sm" onClick={checkServer} aria-label="Retry connecting to server">
              Retry
            </button>
          </div>
        </div>
      )}

      {showHint && !transcript.isRecording && (
        <div className="first-run-hint" role="note">
          <p>
            Open a Google Meet, Teams, or Zoom tab and click <strong>Start</strong>. Platform captions (CC) will be used
            if available; otherwise your mic.
          </p>
          <button className="btn btn-sm" onClick={dismissHint} aria-label="Dismiss this tip">
            Got it
          </button>
        </div>
      )}

      <nav className="tabs" role="tablist" aria-label="Notes sections">
        {TABS.map(({ id, label }, idx) => {
          const badge =
            id === 'notes' && notes.notes && activeTab !== 'notes'
              ? '✓'
              : id === 'questions' && questions.questions.length > 0 && activeTab !== 'questions'
                ? String(questions.questions.length)
                : null;
          return (
            <button
              key={id}
              className={`tab ${activeTab === id ? 'active' : ''}`}
              onClick={() => setActiveTab(id)}
              role="tab"
              aria-selected={activeTab === id}
              aria-controls={`panel-${id}`}
              id={`tab-${id}`}
              title={`${label} (Alt+${idx + 1})`}
              aria-keyshortcuts={`Alt+${idx + 1}`}
            >
              {label}
              {badge && (
                <span className="tab-badge" aria-label={`${badge} new`}>
                  {badge}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <main className="content">
        {activeTab === 'transcript' && (
          <div role="tabpanel" id="panel-transcript" aria-labelledby="tab-transcript">
            <TranscriptView
              segments={isMirroring ? mirror.segments : transcript.segments}
              interimText={isMirroring ? '' : transcript.interimText}
              speakerNames={transcript.speakerNames}
              onRenameSpeaker={transcript.renameSpeaker}
              agentCaptions={isMirroring ? mirror.agentCaptions : agentMirror.captions}
              onAgentFeedback={agentMirror.submitFeedback}
            />
            {transcript.segments.length > 0 && (
              <div className="transcript-save-row">
                <button className="btn btn-sm" onClick={saveTranscript} aria-label="Save transcript as text file">
                  {saveFeedback ? 'Saved!' : 'Save Transcript'}
                </button>
              </div>
            )}
          </div>
        )}

        {activeTab === 'notes' && (
          <div role="tabpanel" id="panel-notes" aria-labelledby="tab-notes">
            <NotesView
              notes={notes.notes}
              isGenerating={notes.isGenerating}
              error={notes.error}
              hasTranscript={transcript.fullTranscript.length > 0}
              onGenerate={() =>
                notes.generate(
                  transcript.fullTranscript,
                  transcript.meetingTitle,
                  transcript.participants,
                  transcript.primaryLang,
                )
              }
            />
            <ExportMenu
              transcript={transcript.fullTranscript}
              notes={notes.notes}
              meetingTitle={transcript.meetingTitle}
              segments={transcript.segments}
              speakerNames={transcript.speakerNames}
              language={transcript.primaryLang}
            />
          </div>
        )}

        {/* Actions / Plan / Review panels intentionally removed — they
            live in the Mac app now.  Use the desktop app for the
            project-management workflow (extract action items, generate
            plans, dispatch tickets, approve via review queue). */}

        {activeTab === 'questions' && (
          <div role="tabpanel" id="panel-questions" aria-labelledby="tab-questions">
            <QuestionsView
              segments={transcript.segments}
              speakerNames={transcript.speakerNames}
              questions={questions.questions}
              isGenerating={questions.isGenerating}
              error={questions.error}
              onGenerate={(ps, ts) => questions.generate(transcript.fullTranscript, ps, ts, transcript.primaryLang)}
              onGenerateFromHistory={() =>
                questions.generateFromHistory(transcript.fullTranscript, transcript.primaryLang)
              }
              onPostToChat={questions.postToChat}
              hasTranscript={transcript.fullTranscript.length > 0}
              agentEnabled={agentEnabled}
              onToggleAgent={setAgentEnabled}
              agentAttached={agent.runs.length > 0}
              agentBusy={agent.busy}
              agentError={agent.error}
              agentLastDecision={agent.runs[0]?.lastDecision?.reason ?? null}
              onClearAgentError={agent.clearError}
              isRecording={transcript.isRecording}
              hasPlan={!!plan.plan?.id}
              planTitle={plan.plan?.title ?? null}
              onRenamePlan={plan.rename}
              onManualAttach={() => agent.dispatch(plan.plan?.id ?? null)}
            />
          </div>
        )}

        {activeTab === 'chat' && (
          <div role="tabpanel" id="panel-chat" aria-labelledby="tab-chat">
            <ChatView
              messages={chat.messages}
              isLoading={chat.isLoading}
              error={chat.error}
              quotaWarning={chat.quotaWarning}
              hasTranscript={transcript.fullTranscript.length > 0}
              onSend={(msg) => chat.sendMessage(msg, transcript.fullTranscript, transcript.primaryLang)}
              onClear={chat.clearChat}
            />
          </div>
        )}

        {activeTab === 'settings' && (
          <div role="tabpanel" id="panel-settings" aria-labelledby="tab-settings">
            <Settings
              devices={audio.devices}
              selectedDeviceId={audio.selectedDeviceId}
              onSelectDevice={audio.selectDevice}
              volume={audio.volume}
              onChangeVolume={audio.changeVolume}
              onRefreshDevices={audio.refreshDevices}
              diagnostics={transcript.diagnostics}
              isRecording={transcript.isRecording}
              captureMode={transcript.captureMode}
            />
          </div>
        )}
      </main>

      {showHelp && <HelpPanel onClose={() => setShowHelp(false)} />}
    </div>
  );
}
