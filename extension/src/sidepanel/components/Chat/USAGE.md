# Chat Component System - Usage Guide

A modular, reusable chat component system with responsive design and consistent styling across different screen sizes.

## Components

### 1. ChatContainer (Main Component)
The complete chat interface with all features.

```tsx
import { ChatContainer } from './Chat';

<ChatContainer
  messages={messages}
  isLoading={isLoading}
  error={error}
  hasTranscript={hasTranscript}
  quotaWarning={quotaWarning}
  onSend={handleSend}
  onClear={handleClear}
  onAddSession={handleAddSession}
  onDeleteSession={handleDeleteSession}
  canDelete={messages.length > 0}
  title="Chat"
  showControls={true}
/>
```

**Props:**
- `messages`: ChatMessageType[] - Array of messages
- `isLoading`: boolean - Show loading state
- `error`: string | null - Error message
- `hasTranscript`: boolean - Enable/disable input
- `quotaWarning?`: string | null - Show quota warning
- `quickPrompts?`: string[] - Custom quick prompts
- `onSend`: (msg: string) => void - Send message handler
- `onClear`: () => void - Clear chat handler
- `onAddSession?`: () => void - Create new session
- `onDeleteSession?`: () => void - Delete session
- `canDelete?`: boolean - Enable delete button
- `title?`: string - Header title
- `showControls?`: boolean - Show header and controls

### 2. ChatMessage (Single Message)
Display a single chat message with proper formatting.

```tsx
import { ChatMessage } from './Chat';

<ChatMessage
  role="assistant"
  content="Hello! How can I help?"
  timestamp={Date.now()}
/>
```

**Props:**
- `role`: 'user' | 'assistant'
- `content`: string - Message text (supports markdown for assistant)
- `timestamp?`: number - Unix timestamp for time display

### 3. ChatInput (Message Input)
Textarea with auto-grow and send button.

```tsx
import { ChatInput } from './Chat';

<ChatInput
  value={input}
  placeholder="Type a message…"
  disabled={false}
  isLoading={false}
  onChange={setInput}
  onSend={handleSend}
/>
```

**Props:**
- `value`: string - Input value
- `placeholder?`: string - Placeholder text
- `disabled?`: boolean - Disable input
- `isLoading?`: boolean - Show loading state
- `onChange`: (value: string) => void
- `onSend`: () => void

### 4. ChatEmpty (Empty State)
Shows when no messages exist.

```tsx
import { ChatEmpty } from './Chat';

<ChatEmpty
  hasTranscript={true}
  onSelectPrompt={handleSelectPrompt}
  quickPrompts={customPrompts}
/>
```

**Props:**
- `hasTranscript`: boolean - Show prompt or recording hint
- `onSelectPrompt`: (prompt: string) => void
- `quickPrompts?`: string[] - Custom prompts

### 5. ChatLoading (Loading Indicator)
Shows animated loading state.

```tsx
import { ChatLoading } from './Chat';

{isLoading && <ChatLoading />}
```

## Responsive Design

The component system is fully responsive:

| Size | Behavior |
|------|----------|
| **Mobile** (<480px) | Full-width messages, compact controls |
| **Tablet** (480-768px) | 90% width messages |
| **Desktop** (>768px) | Max 900px width, 70% user message width |

## Styling & Theming

All components use CSS variables defined in `:root`:

```css
--chat-spacing: 12px;
--chat-radius: 8px;
--chat-max-width: 900px;
```

Color scheme automatically adapts to:
- `--color-primary` - Primary actions
- `--color-danger` - Delete actions
- `--color-text` - Text color
- `--color-bg` - Background

## Example: Complete Implementation

```tsx
import { ChatContainer } from './Chat';
import { useChat } from '../hooks/useChat';

function MyChat() {
  const chat = useChat();
  const [transcript, setTranscript] = useState('');

  return (
    <ChatContainer
      messages={chat.messages}
      isLoading={chat.isLoading}
      error={chat.error}
      hasTranscript={transcript.length > 0}
      quotaWarning={chat.quotaWarning}
      onSend={(msg) => chat.sendMessage(msg, transcript, 'en')}
      onClear={chat.clearChat}
      onAddSession={chat.createNewSession}
      onDeleteSession={chat.deleteCurrentSession}
      canDelete={chat.messages.length > 0}
      title="Chat Assistant"
      showControls={true}
    />
  );
}
```

## Key Features

✅ **Responsive Design**
- Mobile-first approach
- Proper sizing at all breakpoints
- Touch-friendly controls

✅ **Accessibility**
- ARIA labels and roles
- Semantic HTML
- Keyboard navigation (Shift+Enter for newline)

✅ **Consistency**
- Shared design tokens
- Unified styling
- Reusable across all chat surfaces

✅ **Performance**
- Auto-growing textarea
- Smooth animations
- Efficient rendering

✅ **Features**
- Session management (Add/Delete)
- Quick prompts
- Loading states
- Error handling
- Quota warnings
- Markdown support for AI messages

## Migration from Old ChatView

Replace:
```tsx
<ChatView {...props} />
```

With:
```tsx
<ChatContainer {...props} />
```

The new component accepts all the same props and more!

## CSS Classes

Use these classes to customize styling:

- `.chat-container` - Main container
- `.chat-header` - Header with title and controls
- `.chat-messages-container` - Messages area
- `.chat-message` - Individual message
- `.chat-message-user` - User message
- `.chat-message-assistant` - Assistant message
- `.chat-input-wrapper` - Input area
- `.chat-empty-state` - Empty state
- `.chat-loading` - Loading indicator

Example custom styling:
```css
.chat-container {
  background: linear-gradient(to bottom, #1a1a1a, #0d0d0d);
}

.chat-message-assistant .chat-message-content {
  background: rgba(139, 92, 246, 0.1);
  border-color: rgb(139, 92, 246);
}
```
