import React from 'react';

interface ChatEmptyProps {
  hasTranscript: boolean;
  onSelectPrompt: (prompt: string) => void;
  quickPrompts?: string[];
}

const DEFAULT_PROMPTS = [
  'Summarize the key points',
  'What decisions were made?',
  'List all action items',
  'What questions were raised?',
  'Who said what about the deadline?',
];

export default function ChatEmpty({
  hasTranscript,
  onSelectPrompt,
  quickPrompts = DEFAULT_PROMPTS
}: ChatEmptyProps) {
  return (
    <div className="chat-empty-state">
      <div className="chat-empty-icon">💬</div>
      <h3 className="chat-empty-title">Start a conversation</h3>
      <p className="chat-empty-subtitle">Ask anything about the transcript</p>

      {hasTranscript ? (
        <>
          <p className="chat-empty-hint">Suggested questions:</p>
          <div className="chat-quick-prompts" role="list" aria-label="Suggested questions">
            {quickPrompts.map((prompt) => (
              <button
                key={prompt}
                className="chat-quick-prompt"
                role="listitem"
                onClick={() => onSelectPrompt(prompt)}
                aria-label={`Ask: ${prompt}`}
              >
                {prompt}
              </button>
            ))}
          </div>
        </>
      ) : (
        <p className="chat-empty-warning">📹 Start recording first to build a transcript</p>
      )}
    </div>
  );
}
