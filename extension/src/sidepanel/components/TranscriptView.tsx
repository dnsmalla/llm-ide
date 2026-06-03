import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { TranscriptSegment } from '../hooks/useTranscript';

interface Props {
  segments: TranscriptSegment[];
  interimText: string;
  speakerNames: Record<string, string>;
  onRenameSpeaker: (speakerId: string, name: string) => void;
  agentCaptions?: unknown[];
  onAgentFeedback?: (seq: number, verdict: 'useful' | 'noise' | 'later') => Promise<void>;
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// Split text into alternating non-match / match spans for safe highlighting.
// Uses text nodes — no innerHTML, so no XSS risk from caption text.
function highlight(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const q = query.toLowerCase();
  const parts: React.ReactNode[] = [];
  let i = 0;
  while (i < text.length) {
    const idx = text.toLowerCase().indexOf(q, i);
    if (idx === -1) {
      parts.push(text.slice(i));
      break;
    }
    if (idx > i) parts.push(text.slice(i, idx));
    parts.push(
      <mark key={parts.length} className="transcript-match">
        {text.slice(idx, idx + q.length)}
      </mark>,
    );
    i = idx + q.length;
  }
  return parts;
}

export default function TranscriptView({
  segments, interimText, speakerNames, onRenameSpeaker,
  agentCaptions = [], onAgentFeedback,
}: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [editingSpeaker, setEditingSpeaker] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [query, setQuery] = useState('');

  const filteredSegments = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return segments;
    return segments.filter((s) => {
      const displayName = (speakerNames[s.speaker] || s.speaker).toLowerCase();
      return s.text.toLowerCase().includes(q) || displayName.includes(q);
    });
  }, [segments, query, speakerNames]);

  useEffect(() => {
    // Don't auto-scroll while the user is searching — keep their results visible.
    if (query.trim()) return;
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [segments, interimText, query]);

  const handleSpeakerClick = (speakerId: string) => {
    setEditingSpeaker(speakerId);
    setEditName(speakerNames[speakerId] || speakerId);
  };

  const handleRename = () => {
    if (editingSpeaker && editName.trim()) {
      onRenameSpeaker(editingSpeaker, editName.trim());
    }
    setEditingSpeaker(null);
  };

  if (segments.length === 0 && !interimText) {
    return (
      <div className="transcript-empty">
        <p>Transcript will appear here when recording starts.</p>
      </div>
    );
  }

  // Also render interim text under search when the search term doesn't match it.
  const showInterim = !query.trim() || interimText.toLowerCase().includes(query.trim().toLowerCase());

  // Group consecutive segments by the same speaker
  const grouped: { speaker: string; texts: { text: string; timestamp: number; lang?: string }[] }[] = [];
  for (const seg of filteredSegments) {
    const last = grouped[grouped.length - 1];
    if (last && last.speaker === seg.speaker) {
      last.texts.push({ text: seg.text, timestamp: seg.timestamp, lang: seg.lang });
    } else {
      grouped.push({ speaker: seg.speaker, texts: [{ text: seg.text, timestamp: seg.timestamp, lang: seg.lang }] });
    }
  }

  const trimmedQuery = query.trim();

  return (
    <div className="transcript-view">
      <div className="transcript-search-row">
        <input
          type="search"
          className="transcript-search-input"
          placeholder="Search transcript…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search transcript"
        />
        {trimmedQuery && (
          <span className="transcript-search-count" aria-live="polite">
            {filteredSegments.length} / {segments.length}
          </span>
        )}
      </div>
      {editingSpeaker && (
        <div className="speaker-rename-bar" role="dialog" aria-label="Rename speaker">
          <input
            className="speaker-rename-input"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleRename();
              if (e.key === 'Escape') setEditingSpeaker(null);
            }}
            aria-label="New speaker name"
            placeholder="Speaker name"
            maxLength={50}
            autoFocus
          />
          <button
            className="btn btn-sm"
            onClick={handleRename}
            disabled={!editName.trim()}
            aria-label="Save speaker name"
          >
            Save
          </button>
          <button
            className="btn btn-sm"
            onClick={() => setEditingSpeaker(null)}
            aria-label="Cancel renaming"
          >
            Cancel
          </button>
        </div>
      )}
      {grouped.map((group, i) => {
        const displayName = speakerNames[group.speaker] || group.speaker;
        const firstTs = group.texts[0].timestamp;
        return (
          <div key={`group-${i}`} className="transcript-group">
            <div className="transcript-speaker-row">
              <button
                type="button"
                className="transcript-speaker"
                onClick={() => handleSpeakerClick(group.speaker)}
                title="Click to rename speaker"
                aria-label={`Rename ${displayName}`}
              >
                {displayName}
              </button>
              <span className="transcript-time">{formatTimestamp(firstTs)}</span>
            </div>
            <div className="transcript-texts">
              {group.texts.map((t, j) => (
                <span key={j} className="transcript-text">
                  {t.lang && <span className="transcript-lang">{t.lang.split('-')[0]}</span>}
                  {highlight(t.text, trimmedQuery)}{' '}
                </span>
              ))}
            </div>
          </div>
        );
      })}
      {interimText && showInterim && (
        <div className="transcript-group interim">
          <div className="transcript-texts">
            <span className="transcript-text">{interimText}</span>
          </div>
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}
