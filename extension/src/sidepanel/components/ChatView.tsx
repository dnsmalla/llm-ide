import React, { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import type { ChatMessage } from '../hooks/useChat';

interface Props {
  messages: ChatMessage[];
  isLoading: boolean;
  error: string | null;
  quotaWarning?: string | null;
  hasTranscript: boolean;
  onSend: (message: string) => void;
  onClear: () => void;
}

const QUICK_PROMPTS = [
  'Summarize the key points',
  'What decisions were made?',
  'List all action items',
  'What questions were raised?',
  'Who said what about the deadline?',
];

export default function ChatView({ messages, isLoading, error, quotaWarning, hasTranscript, onSend, onClear }: Props) {
  const [input, setInput] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  // Guard against double-submit when Enter fires before isLoading flips.
  const sendingRef = useRef(false);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  // Reset the send guard when the loading state clears.
  useEffect(() => {
    if (!isLoading) sendingRef.current = false;
  }, [isLoading]);

  const handleSend = () => {
    const text = input.trim();
    if (!text || isLoading || sendingRef.current) return;
    sendingRef.current = true;
    setInput('');
    onSend(text);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="chat-view">
      {quotaWarning && (
        <div className="error-message quota-warning" role="alert">{quotaWarning}</div>
      )}
      {/* role="log" + aria-live so screen readers announce new messages.
          aria-atomic="false" means only new nodes are announced, not the
          whole log re-read every time. */}
      <div
        className="chat-messages"
        role="log"
        aria-live="polite"
        aria-atomic="false"
        aria-label="Chat conversation"
      >
        {messages.length === 0 && !isLoading && (
          <div className="chat-empty">
            <p>Ask anything about the transcript</p>
            {hasTranscript ? (
              <div className="quick-prompts" role="list" aria-label="Suggested questions">
                {QUICK_PROMPTS.map((prompt) => (
                  <button
                    key={prompt}
                    className="quick-prompt"
                    role="listitem"
                    onClick={() => onSend(prompt)}
                    aria-label={`Ask: ${prompt}`}
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            ) : (
              <p className="chat-hint">Start recording first to build a transcript.</p>
            )}
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`chat-msg chat-msg-${msg.role}`}>
            <div className="chat-msg-label" aria-hidden="true">
              {msg.role === 'user' ? 'You' : 'AI'}
            </div>
            <div
              className="chat-msg-content"
              aria-label={`${msg.role === 'user' ? 'You' : 'Assistant'}: ${msg.content}`}
            >
              {msg.role === 'assistant' ? (
                <ReactMarkdown rehypePlugins={[rehypeSanitize]}>{msg.content}</ReactMarkdown>
              ) : (
                msg.content
              )}
            </div>
          </div>
        ))}
        {isLoading && (
          <div className="chat-msg chat-msg-assistant" aria-busy="true">
            <div className="chat-msg-label" aria-hidden="true">AI</div>
            <div className="chat-msg-content">
              <div className="chat-typing" role="status" aria-label="Assistant is thinking">
                <span aria-hidden="true">Thinking…</span>
              </div>
            </div>
          </div>
        )}
        {error && (
          <div className="error-message" role="alert" aria-live="assertive">
            {error}
          </div>
        )}
        <div ref={bottomRef} aria-hidden="true" />
      </div>

      <div className="chat-input-row">
        <textarea
          className="chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={hasTranscript ? 'Ask about the transcript… (Enter to send)' : 'Record a meeting first…'}
          disabled={!hasTranscript || isLoading}
          rows={1}
          aria-label="Chat message input"
          aria-describedby={!hasTranscript ? 'chat-no-transcript-hint' : undefined}
        />
        <button
          type="button"
          className="btn btn-send"
          onClick={handleSend}
          disabled={!input.trim() || isLoading || !hasTranscript}
          aria-label="Send message"
          aria-busy={isLoading}
        >
          Send
        </button>
      </div>
      {!hasTranscript && (
        <p id="chat-no-transcript-hint" className="chat-hint" aria-live="polite">
          Start recording to enable chat.
        </p>
      )}
      {messages.length > 0 && (
        <button
          type="button"
          className="btn btn-sm chat-clear"
          onClick={onClear}
          aria-label="Clear chat history"
        >
          Clear Chat
        </button>
      )}
    </div>
  );
}
