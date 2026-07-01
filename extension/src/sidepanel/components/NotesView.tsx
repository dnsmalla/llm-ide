import React from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';

interface Props {
  notes: string;
  isGenerating: boolean;
  error: string | null;
  onGenerate: () => void;
  hasTranscript: boolean;
}

export default function NotesView({ notes, isGenerating, error, onGenerate, hasTranscript }: Props) {
  return (
    <div className="notes-view">
      {!notes && !isGenerating && !error && (
        <button
          className="btn btn-generate"
          onClick={onGenerate}
          disabled={!hasTranscript}
          aria-label={hasTranscript ? 'Generate meeting notes from transcript' : 'Recording required first'}
        >
          {hasTranscript ? 'Generate Notes' : 'Record a meeting first'}
        </button>
      )}
      {isGenerating && (
        <div className="notes-loading" role="status" aria-live="polite">
          <div className="spinner" aria-hidden="true" />
          <p>Generating meeting notes…</p>
        </div>
      )}
      {error && (
        <div className="error-message" role="alert">
          <p>{error}</p>
          <button className="btn btn-sm btn-retry" onClick={onGenerate} aria-label="Retry generating notes">
            Retry
          </button>
        </div>
      )}
      {notes && (
        <div className="notes-content">
          <ReactMarkdown rehypePlugins={[rehypeSanitize]}>{notes}</ReactMarkdown>
          <button className="btn btn-sm btn-regenerate" onClick={onGenerate} aria-label="Regenerate notes">
            Regenerate
          </button>
        </div>
      )}
    </div>
  );
}
