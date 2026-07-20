import React from 'react';

export default function ChatLoading() {
  return (
    <div className="chat-message chat-message-assistant" aria-busy="true">
      <div className="chat-message-header">
        <span className="chat-message-label" aria-hidden="true">
          AI
        </span>
      </div>
      <div className="chat-message-content">
        <div className="chat-typing-indicator" role="status" aria-label="Assistant is thinking">
          <span></span>
          <span></span>
          <span></span>
        </div>
      </div>
    </div>
  );
}
