import React from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';

interface ChatMessageProps {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: number;
}

export default function ChatMessage({ role, content, timestamp }: ChatMessageProps) {
  const label = role === 'user' ? 'You' : 'AI';
  const timeStr = timestamp ? new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

  return (
    <div className={`chat-message chat-message-${role}`}>
      <div className="chat-message-header">
        <span className="chat-message-label" aria-hidden="true">
          {label}
        </span>
        {timeStr && <span className="chat-message-time">{timeStr}</span>}
      </div>
      <div
        className="chat-message-content"
        aria-label={`${label}: ${content}`}
      >
        {role === 'assistant' ? (
          <ReactMarkdown rehypePlugins={[rehypeSanitize]}>
            {content}
          </ReactMarkdown>
        ) : (
          content
        )}
      </div>
    </div>
  );
}
