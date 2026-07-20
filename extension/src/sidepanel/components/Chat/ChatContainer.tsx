import React, { useState, useRef, useEffect } from 'react';
import ChatMessage from './ChatMessage';
import ChatInput from './ChatInput';
import ChatEmpty from './ChatEmpty';
import ChatLoading from './ChatLoading';

export interface ChatMessage as ChatMessageType {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

interface ChatContainerProps {
  messages: ChatMessageType[];
  isLoading: boolean;
  error: string | null;
  hasTranscript: boolean;
  quotaWarning?: string | null;
  quickPrompts?: string[];
  onSend: (message: string) => void;
  onClear: () => void;
  onAddSession?: () => void;
  onDeleteSession?: () => void;
  canDelete?: boolean;
  title?: string;
  showControls?: boolean;
}

export default function ChatContainer({
  messages,
  isLoading,
  error,
  hasTranscript,
  quotaWarning,
  quickPrompts,
  onSend,
  onClear,
  onAddSession,
  onDeleteSession,
  canDelete = true,
  title,
  showControls = true
}: ChatContainerProps) {
  const [input, setInput] = useState('');
  const [sendingRef, setSendingRef] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  // Reset send guard
  useEffect(() => {
    if (!isLoading) setSendingRef(false);
  }, [isLoading]);

  const handleSend = () => {
    const text = input.trim();
    if (!text || isLoading || sendingRef) return;
    setSendingRef(true);
    setInput('');
    onSend(text);
  };

  return (
    <div className="chat-container">
      {/* Header with session controls */}
      {showControls && (title || onAddSession || onDeleteSession) && (
        <div className="chat-header">
          {title && <h3 className="chat-title">{title}</h3>}
          {(onAddSession || onDeleteSession) && (
            <div className="chat-controls">
              {onAddSession && (
                <button
                  className="chat-control-btn chat-btn-add"
                  onClick={onAddSession}
                  title="New chat session"
                  aria-label="Start new session"
                >
                  ➕
                </button>
              )}
              {onDeleteSession && (
                <button
                  className="chat-control-btn chat-btn-delete"
                  onClick={onDeleteSession}
                  disabled={!canDelete}
                  title="Delete session"
                  aria-label="Delete session"
                >
                  🗑️
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Alerts */}
      {quotaWarning && (
        <div className="chat-alert chat-alert-warning" role="alert">
          {quotaWarning}
        </div>
      )}
      {error && (
        <div className="chat-alert chat-alert-error" role="alert" aria-live="assertive">
          {error}
        </div>
      )}

      {/* Messages area */}
      <div className="chat-messages-container" role="log" aria-live="polite" aria-atomic="false">
        {messages.length === 0 && !isLoading && (
          <ChatEmpty
            hasTranscript={hasTranscript}
            onSelectPrompt={(prompt) => {
              setInput('');
              onSend(prompt);
            }}
            quickPrompts={quickPrompts}
          />
        )}

        {messages.map((msg, i) => (
          <ChatMessage key={i} role={msg.role} content={msg.content} timestamp={msg.timestamp} />
        ))}

        {isLoading && <ChatLoading />}

        <div ref={messagesEndRef} aria-hidden="true" />
      </div>

      {/* Input area */}
      <div className="chat-footer">
        <ChatInput
          value={input}
          disabled={!hasTranscript}
          isLoading={isLoading}
          placeholder={
            hasTranscript ? 'Ask about the transcript… (Shift+Enter for new line)' : 'Record a meeting first…'
          }
          onChange={setInput}
          onSend={handleSend}
        />

        {/* Action buttons */}
        <div className="chat-actions">
          {!hasTranscript && <p className="chat-hint">📹 Start recording to enable chat</p>}
          {messages.length > 0 && (
            <button type="button" className="chat-action-btn" onClick={onClear} aria-label="Clear chat">
              Clear
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
