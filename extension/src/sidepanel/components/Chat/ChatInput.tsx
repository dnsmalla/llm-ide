import React, { useRef, useEffect } from 'react';

interface ChatInputProps {
  value: string;
  placeholder?: string;
  disabled?: boolean;
  isLoading?: boolean;
  onChange: (value: string) => void;
  onSend: () => void;
  onKeyDown?: (e: React.KeyboardEvent) => void;
}

export default function ChatInput({
  value,
  placeholder = 'Type a message…',
  disabled = false,
  isLoading = false,
  onChange,
  onSend,
  onKeyDown
}: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 120) + 'px';
    }
  }, [value]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (onKeyDown) {
      onKeyDown(e);
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  };

  return (
    <div className="chat-input-wrapper">
      <textarea
        ref={textareaRef}
        className="chat-input-field"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled || isLoading}
        rows={1}
        aria-label="Chat message input"
      />
      <button
        type="button"
        className="chat-send-btn"
        onClick={onSend}
        disabled={!value.trim() || isLoading || disabled}
        aria-label="Send message"
        aria-busy={isLoading}
      >
        {isLoading ? '⏳' : '→'}
      </button>
    </div>
  );
}
