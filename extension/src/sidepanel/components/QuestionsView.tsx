import React, { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import type { TranscriptSegment } from '../hooks/useTranscript';
import type { QuestionType } from '../hooks/useQuestions';

interface Props {
  segments: TranscriptSegment[];
  speakerNames: Record<string, string>;
  questions: string;
  isGenerating: boolean;
  error: string | null;
  onGenerate: (participants: string[], types: QuestionType[]) => void;
  onGenerateFromHistory: () => void;
  onPostToChat: (text: string) => void;
  hasTranscript: boolean;
  // ── AI assistant (formerly the header AgentControls pill).  Now
  // inline at the top of the Questions tab so the user controls it
  // from the place where its output naturally lands.  Auto-attaches
  // on recording start when enabled.
  agentEnabled: boolean;
  onToggleAgent: (next: boolean) => void;
  agentAttached: boolean;
  agentBusy: boolean;
  agentError: string | null;
  agentLastDecision: string | null;
  onClearAgentError: () => void;
  isRecording: boolean;
  /** True when an active plan exists in the KB.  Auto-attach only
   *  fires with a plan, so without one the toggle bar shows a hint
   *  + a one-click "Attach anyway" escape hatch. */
  hasPlan: boolean;
  /** Current plan title, used for inline rename in the toggle bar. */
  planTitle: string | null;
  /** Rename the current plan — returns the saved plan or null on error. */
  onRenamePlan: (newTitle: string) => Promise<unknown>;
  onManualAttach: () => void;
}

const TYPE_OPTIONS: { id: QuestionType; label: string; hint: string }[] = [
  { id: 'conflict', label: 'Conflicts', hint: 'Contradictions between speakers' },
  { id: 'confirm', label: 'Needs confirmation', hint: 'Decisions, numbers, commitments' },
  { id: 'explain', label: 'Needs more detail', hint: 'Vague or skipped reasoning' },
];

// Persistence shape for the saved "customize" state.  Stored in
// chrome.storage.local under one key so a sign-in switch doesn't lose
// the user's preference, but it doesn't need to roam across devices —
// chrome.storage.sync is overkill for a few short lists.
const PREFS_KEY = 'questions.prefs.v1';
const DEFAULT_TYPES: QuestionType[] = ['conflict', 'confirm'];
interface SavedPrefs {
  /** null → "all currently-detected speakers" (default).  Saving an
   *  explicit list pins it across regenerations. */
  participants: string[] | null;
  types: QuestionType[];
}
function loadPrefs(): SavedPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) {
      const j = JSON.parse(raw);
      const types = Array.isArray(j?.types)
        ? j.types.filter((t: unknown): t is QuestionType => t === 'conflict' || t === 'confirm' || t === 'explain')
        : DEFAULT_TYPES;
      const participants = Array.isArray(j?.participants)
        ? j.participants.filter((p: unknown): p is string => typeof p === 'string')
        : null;
      return { participants, types: types.length ? types : DEFAULT_TYPES };
    }
  } catch {
    /* corrupted blob — fall through to defaults */
  }
  return { participants: null, types: DEFAULT_TYPES };
}
function savePrefs(prefs: SavedPrefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* quota — non-fatal, defaults still apply */
  }
}

export default function QuestionsView({
  segments,
  speakerNames,
  questions,
  isGenerating,
  error,
  onGenerate,
  onGenerateFromHistory,
  onPostToChat,
  hasTranscript,
  agentEnabled,
  onToggleAgent,
  agentAttached,
  agentBusy,
  agentError,
  agentLastDecision,
  onClearAgentError,
  isRecording,
  hasPlan,
  planTitle,
  onRenamePlan,
  onManualAttach,
}: Props) {
  // Inline plan rename — collapsed by default (just shows the title
  // as text), expands to an input on click of the ✎ pencil.
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const startRename = () => {
    setRenameDraft(planTitle ?? '');
    setRenaming(true);
  };
  const commitRename = async () => {
    const v = renameDraft.trim();
    setRenaming(false);
    if (!v || v === planTitle) return;
    await onRenamePlan(v);
  };
  // Build the list of people who actually spoke in the transcript.
  // Using the display name if one has been assigned, otherwise the raw id.
  const availableParticipants = useMemo(() => {
    const seen = new Map<string, number>();
    for (const seg of segments) {
      const name = speakerNames[seg.speaker] || seg.speaker;
      seen.set(name, (seen.get(name) ?? 0) + 1);
    }
    // Sort by turn count descending — most active speakers first.
    return Array.from(seen.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([name]) => name);
  }, [segments, speakerNames]);

  // Saved-on-disk user customization.  Defaults: all detected speakers
  // + Conflicts/Confirm question types.  Stays minimal so the common
  // case ("just give me good questions") is one click.
  const [savedPrefs, setSavedPrefs] = useState<SavedPrefs>(() => loadPrefs());

  // EFFECTIVE selection feeding the generator — pinned list if the
  // user has explicitly saved one, otherwise live-derived from the
  // current speakers.  This is what actually gets sent to the API.
  const effectiveParticipants = savedPrefs.participants ?? availableParticipants;
  const effectiveTypes = savedPrefs.types;

  // Customize panel state — collapsed by default.  When opened we
  // copy from saved prefs into local draft so edits don't take effect
  // until the user clicks Save.  Cancel discards.
  const [editing, setEditing] = useState(false);
  const [draftParticipants, setDraftParticipants] = useState<string[]>([]);
  const [draftTypes, setDraftTypes] = useState<QuestionType[]>(DEFAULT_TYPES);
  const [justSaved, setJustSaved] = useState(false);

  function openEditor() {
    setDraftParticipants(effectiveParticipants);
    setDraftTypes(effectiveTypes);
    setJustSaved(false);
    setEditing(true);
  }
  function cancelEditor() {
    setEditing(false);
  }
  function saveEditor() {
    // Empty draft → treat as "reset to defaults" rather than blocking
    // generation entirely.  Also clamp to a sane minimum so a slip
    // can't disable the Generate button on re-render.
    const cleanTypes = draftTypes.length > 0 ? draftTypes : DEFAULT_TYPES;
    // If the draft EQUALS all currently-detected speakers, store null
    // (= "auto-follow the meeting") instead of pinning the exact list.
    // That way adding a participant later is automatically picked up.
    const matchesAuto =
      draftParticipants.length === availableParticipants.length &&
      draftParticipants.every((p) => availableParticipants.includes(p));
    const next: SavedPrefs = {
      participants: matchesAuto ? null : draftParticipants,
      types: cleanTypes,
    };
    setSavedPrefs(next);
    savePrefs(next);
    setEditing(false);
    setJustSaved(true);
    setTimeout(() => setJustSaved(false), 2000);
  }
  function resetEditor() {
    const cleared: SavedPrefs = { participants: null, types: DEFAULT_TYPES };
    setSavedPrefs(cleared);
    savePrefs(cleared);
    setEditing(false);
  }

  const toggleDraftParticipant = (name: string) =>
    setDraftParticipants((p) => (p.includes(name) ? p.filter((n) => n !== name) : [...p, name]));
  const toggleDraftType = (id: QuestionType) =>
    setDraftTypes((p) => (p.includes(id) ? p.filter((t) => t !== id) : [...p, id]));

  const canGenerate = hasTranscript && effectiveTypes.length > 0 && effectiveParticipants.length > 0 && !isGenerating;

  // Short, scan-friendly summary of what Generate will use right now.
  // E.g. "Will ask about: Alice, Bob · Conflicts, Needs confirmation"
  const typeLabel = (id: QuestionType) => TYPE_OPTIONS.find((t) => t.id === id)?.label ?? id;
  const summaryLine = (() => {
    const ppl =
      effectiveParticipants.length === 0
        ? '(no speakers detected yet)'
        : effectiveParticipants.length <= 3
          ? effectiveParticipants.join(', ')
          : `${effectiveParticipants.slice(0, 2).join(', ')} +${effectiveParticipants.length - 2} more`;
    const ts = effectiveTypes.map(typeLabel).join(', ') || '(none)';
    return `${ppl} · ${ts}`;
  })();

  // Simple parser to extract list-item questions from markdown
  const parsedQuestions = useMemo(() => {
    if (!questions) return [];
    return questions
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^(\d+\. |[-*] )/.test(line))
      .map((line) => line.replace(/^(\d+\. |[-*] )/, ''));
  }, [questions]);

  // Compact "AI Assistant" toggle bar — replaces the old header
  // AgentControls pill.  Reflects three states:
  //   - enabled + attached     → green dot + last tick reason
  //   - enabled + waiting      → amber dot + "auto-attach on record"
  //   - disabled               → grey dot + "AI assistant: off"
  const agentBar = (
    <div className={`agent-toggle-bar ${agentEnabled ? 'on' : 'off'}`}>
      <label
        className="agent-toggle-switch"
        title={agentEnabled ? 'Turn off the AI assistant' : 'Turn on the AI assistant'}
      >
        <input
          type="checkbox"
          checked={agentEnabled}
          onChange={(e) => onToggleAgent(e.target.checked)}
          disabled={agentBusy}
          aria-label="AI assistant on/off"
        />
        <span className="agent-toggle-slider" aria-hidden="true" />
      </label>
      <div className="agent-toggle-text">
        <div className="agent-toggle-title">
          <span
            className={`agent-status-dot ${
              !agentEnabled
                ? 'agent-status-dot--off'
                : agentAttached
                  ? 'agent-status-dot--on'
                  : 'agent-status-dot--standby'
            }`}
            aria-hidden="true"
          >
            ●
          </span>
          AI assistant: {agentEnabled ? (agentAttached ? 'on' : 'standby') : 'off'}
        </div>
        <div className="agent-toggle-sub">
          {!agentEnabled
            ? 'Will not attach on recording.'
            : agentAttached
              ? agentLastDecision
                ? `watching · ${agentLastDecision}`
                : 'watching · just attached'
              : !hasPlan
                ? isRecording
                  ? 'creating starter plan…'
                  : 'attaches automatically when you start recording'
                : isRecording
                  ? 'attaching…'
                  : 'attaches automatically when you start recording'}
        </div>
        {/* Inline plan rename — appears whenever there's a plan, even
            before the agent attaches.  Click ✎ to edit; Enter or
            blur commits; Esc cancels.  Lets the user personalize the
            auto-generated stub name without leaving the Questions tab. */}
        {planTitle && (
          <div className="agent-toggle-plan">
            {renaming ? (
              <input
                className="agent-plan-input"
                value={renameDraft}
                onChange={(e) => setRenameDraft(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename();
                  if (e.key === 'Escape') setRenaming(false);
                }}
                autoFocus
                maxLength={200}
                aria-label="Plan name"
              />
            ) : (
              <>
                <span className="agent-plan-label" title={planTitle}>
                  Plan: {planTitle.length > 40 ? `${planTitle.slice(0, 40)}…` : planTitle}
                </span>
                <button className="agent-plan-edit" onClick={startRename} title="Rename plan" aria-label="Rename plan">
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                  </svg>
                </button>
              </>
            )}
          </div>
        )}
        {agentEnabled && isRecording && !agentAttached && !hasPlan && (
          <button
            className="btn-link agent-attach-anyway"
            onClick={onManualAttach}
            disabled={agentBusy}
            title="Attach the agent without a plan — it will observe only and won't ask questions."
          >
            Attach anyway (observe only)
          </button>
        )}
        {agentError && (
          <div className="agent-toggle-error" role="alert" onClick={onClearAgentError} title="Click to dismiss">
            {agentError.length > 100 ? `${agentError.slice(0, 100)}…` : agentError}
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              aria-hidden="true"
              style={{ marginLeft: '6px', flexShrink: 0 }}
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </div>
        )}
      </div>
    </div>
  );

  if (!hasTranscript) {
    return (
      <div className="questions-view">
        {agentBar}
        <div className="questions-empty">
          <p>Record a meeting first, then come back to generate targeted follow-up questions.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="questions-view">
      {agentBar}
      {/*
        Defaults-first layout.  The big Participants + Question-types
        forms are collapsed behind a "Customize" disclosure — the
        common case is "just generate" with all detected speakers
        and the two most useful question types.  Open the disclosure
        to override; click Save & use to persist; Reset to defaults
        clears the pin.  Saved prefs live in localStorage.
      */}
      <div className="questions-defaults">
        <button
          className="btn btn-generate"
          onClick={() => onGenerate(effectiveParticipants, effectiveTypes)}
          disabled={!canGenerate}
          aria-label="Generate follow-up questions"
        >
          {isGenerating ? 'Generating…' : 'Generate Questions'}
        </button>
        <button
          className="btn btn-secondary"
          onClick={onGenerateFromHistory}
          disabled={isGenerating}
          title="Find conflicts and undecided items by comparing the current transcript against past meeting notes and code in the knowledge base"
          aria-label="Generate questions from history"
        >
          From history
        </button>
        <div className="questions-summary" title={summaryLine}>
          {summaryLine}
          {savedPrefs.participants !== null && (
            <span className="questions-pinned-badge" title="Saved customization in use">
              pinned
            </span>
          )}
          {justSaved && <span className="questions-saved-flash">✓ saved</span>}
        </div>
        <button
          className="questions-customize-toggle"
          onClick={() => (editing ? cancelEditor() : openEditor())}
          aria-expanded={editing}
        >
          {editing ? 'Cancel' : 'Customize'}
        </button>
      </div>

      {editing && (
        <div className="questions-editor">
          <section className="questions-section">
            <h3 className="questions-heading">Participants</h3>
            {availableParticipants.length === 0 ? (
              <p className="questions-hint">No speakers detected yet.</p>
            ) : (
              <div className="questions-chip-row">
                {availableParticipants.map((name) => {
                  const checked = draftParticipants.includes(name);
                  return (
                    <label key={name} className={`questions-chip ${checked ? 'checked' : ''}`}>
                      <input type="checkbox" checked={checked} onChange={() => toggleDraftParticipant(name)} />
                      <span>{name}</span>
                    </label>
                  );
                })}
              </div>
            )}
          </section>

          <section className="questions-section">
            <h3 className="questions-heading">Question types</h3>
            <div className="questions-type-list">
              {TYPE_OPTIONS.map(({ id, label, hint }) => {
                const checked = draftTypes.includes(id);
                return (
                  <label key={id} className={`questions-type ${checked ? 'checked' : ''}`}>
                    <input type="checkbox" checked={checked} onChange={() => toggleDraftType(id)} />
                    <span className="questions-type-label">{label}</span>
                    <span className="questions-type-hint">{hint}</span>
                  </label>
                );
              })}
            </div>
          </section>

          <div className="questions-editor-actions">
            <button
              className="btn btn-save"
              onClick={saveEditor}
              disabled={draftTypes.length === 0 || draftParticipants.length === 0}
              title="Remember these choices for next time"
            >
              Save & use
            </button>
            <button className="btn btn-secondary" onClick={cancelEditor} title="Discard edits">
              Cancel
            </button>
            {savedPrefs.participants !== null && (
              <button
                className="btn btn-link"
                onClick={resetEditor}
                title="Clear saved choices and follow detected speakers again"
              >
                Reset to defaults
              </button>
            )}
          </div>
        </div>
      )}

      {isGenerating && (
        <div className="notes-loading" role="status" aria-live="polite">
          <div className="spinner" aria-hidden="true" />
          <p>Analyzing transcript…</p>
        </div>
      )}

      {error && (
        <div className="error-message" role="alert">
          <p>{error}</p>
        </div>
      )}

      {questions && !isGenerating && (
        <div className="notes-content">
          <ReactMarkdown rehypePlugins={[rehypeSanitize]}>{questions}</ReactMarkdown>
          {parsedQuestions.length > 0 && (
            <div className="questions-actions">
              <h4 className="questions-subheading">Post to Chat</h4>
              <div className="questions-post-list">
                {parsedQuestions.map((q, idx) => (
                  <div key={idx} className="question-post-item">
                    <p className="question-post-text">{q}</p>
                    <button
                      className="btn btn-sm btn-post"
                      onClick={() => onPostToChat(q)}
                      title="Send this question to Google Meet chat"
                    >
                      Post to Meet
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
