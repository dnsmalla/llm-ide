// Chat Component System - Reusable, Responsive & Voice-Enabled

// Core Components
// The message-shape type lives in hooks/useChat (and ChatContainer exports it
// directly for ChatWithVoice); don't re-export it here — it collides with the
// ChatMessage *component* below and nothing consumes the type via this barrel.
export { default as ChatContainer } from './ChatContainer';
export { default as ChatMessage } from './ChatMessage';
export { default as ChatInput } from './ChatInput';
export { default as ChatEmpty } from './ChatEmpty';
export { default as ChatLoading } from './ChatLoading';

// Voice & Mobile Features
export { default as ChatWithVoice } from './ChatWithVoice';
export { default as MobileControl } from './MobileControl';

// Styles
import './Chat.css';
