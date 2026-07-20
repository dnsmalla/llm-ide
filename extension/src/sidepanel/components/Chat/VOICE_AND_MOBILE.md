# Voice Input & Mobile Control - Advanced Chat Features

Enhanced chat system with **voice input**, **real-time typing**, **mobile app integration**, and **keyboard shortcuts** for fast interaction.

## Features Overview

### 🎤 Voice Input
- **Web Speech API** integration for real-time speech-to-text
- **Interim results** showing while speaking (like OpenAI's)
- **Recording indicator** with pulse animation
- **Keyboard shortcut**: `Ctrl/Cmd + M` to toggle voice
- Real-time feedback to mobile app

### 📱 Mobile App Control
- **Direct chat control** of mobile app
- **Quick actions** (scroll, tap, back, home, screenshot)
- **Real-time status** - connected/disconnected indicator
- **Mobile commands** sent via chat messages
- **Keyboard shortcuts** for mobile navigation

### ⚡ Fast Real-Time Input
- **Auto-growing textarea**
- **Interim text display** while speaking
- **Live typing indicator** for mobile
- **OpenAI-style keyboard** response speed
- Minimal latency

---

## Component: ChatWithVoice

Complete chat interface with voice and mobile integration.

```tsx
import { ChatWithVoice } from './Chat';

<ChatWithVoice
  messages={messages}
  isLoading={isLoading}
  error={error}
  hasTranscript={hasTranscript}
  onSend={handleSend}
  onClear={handleClear}
  onMobileCommand={handleMobileCommand}
  isMobileConnected={isMobileConnected}
  title="AI Assistant"
  showControls={true}
/>
```

### Props

| Prop | Type | Description |
|------|------|-------------|
| `messages` | ChatMessage[] | Chat messages to display |
| `isLoading` | boolean | Show loading state |
| `error` | string \| null | Error message |
| `hasTranscript` | boolean | Enable/disable input |
| `onSend` | (msg: string) => void | Send message handler |
| `onClear` | () => void | Clear chat handler |
| `onMobileCommand` | (cmd: string) => void | Mobile command handler |
| `isMobileConnected` | boolean | Mobile connection status |
| `title` | string | Header title |
| `showControls` | boolean | Show header controls |

---

## Component: MobileControl

Manages mobile app connectivity and quick actions.

```tsx
import { MobileControl } from './Chat';

<MobileControl
  isConnected={isConnected}
  onCommand={handleCommand}
  onConnect={connect}
  onDisconnect={disconnect}
/>
```

### Quick Actions

| Action | Keyboard | Description |
|--------|----------|-------------|
| Scroll Up | `Alt + ↑` | Scroll up on mobile |
| Scroll Down | `Alt + ↓` | Scroll down on mobile |
| Back | `Alt + Backspace` | Go back on mobile |
| Home | — | Go to home screen |
| Tap | — | Simulate tap |
| Screenshot | — | Take screenshot |

---

## Voice Input Details

### How It Works

1. **User clicks 🎤 button** or presses `Ctrl/Cmd + M`
2. **Browser requests microphone permission**
3. **Web Speech API** captures audio
4. **Interim results** show real-time transcription
5. **Final results** are added to input field
6. **Mobile app** receives real-time feedback

### Keyboard Shortcuts

```
Ctrl/Cmd + M   → Toggle voice recording
Ctrl/Cmd + Shift + A → Mobile quick action
Alt + ↑        → Scroll up (mobile)
Alt + ↓        → Scroll down (mobile)
Alt + Backspace → Back (mobile)
Shift + Enter  → New line in input
```

### Real-Time Feedback

While speaking:
- Input shows `[interim]` tag with live text
- Cursor blinks in real-time
- Mobile app receives `voice:` command with partial text
- Visual recording indicator pulses

### Browser Support

| Browser | Support | Notes |
|---------|---------|-------|
| Chrome | ✅ Full | Best support |
| Edge | ✅ Full | Works well |
| Safari | ⚠️ Partial | May require permission |
| Firefox | ⚠️ Limited | Partial support |

---

## Mobile App Integration

### Command Format

```typescript
// Voice command
voice:transcript text here

// Typing feedback  
typing:what user is typing

// Send command
send:final message to send

// Mobile navigation
mobile:scroll direction=up
mobile:back
mobile:home
mobile:tap
mobile:screenshot
```

### Connection States

```typescript
// Connected
{
  isConnected: true,
  status: 'Connected to Mobile',
  indicator: 'green pulse'
}

// Disconnected  
{
  isConnected: false,
  status: 'Mobile Offline',
  indicator: 'gray'
}
```

---

## Real-Time Styling

### Recording State
- **Button**: Red background with pulse animation
- **Recording dot**: Blinking indicator
- **Wave**: Expanding wave animation
- **Indicator bar**: Slide-down animation

### Mobile Status
- **Connected**: Green with pulse
- **Disconnected**: Yellow warning
- **Real-time updates**: Smooth transitions

### Interim Text
- **Display**: Italic, muted color
- **Cursor**: Blinking animation
- **Update**: Smooth text replacement

---

## Usage Example

```tsx
import { ChatWithVoice } from './Chat/';
import { useChat } from '../hooks/useChat';
import { useEffect, useState } from 'react';

function App() {
  const chat = useChat();
  const [isMobileConnected, setIsMobileConnected] = useState(false);

  const handleMobileCommand = (command: string, data?: any) => {
    console.log('Mobile command:', command, data);
    
    // Handle different command types
    if (command.startsWith('voice:')) {
      const text = command.substring(6);
      chat.sendMessage(text, '', 'en');
    } else if (command.startsWith('mobile:')) {
      // Handle mobile app commands
      const action = command.substring(7);
      handleMobileAction(action);
    }
  };

  const handleMobileAction = (action: string) => {
    // Send to mobile app API
    fetch('http://127.0.0.1:3456/mobile/command', {
      method: 'POST',
      body: JSON.stringify({ action })
    });
  };

  return (
    <ChatWithVoice
      messages={chat.messages}
      isLoading={chat.isLoading}
      error={chat.error}
      hasTranscript={true}
      onSend={(msg) => chat.sendMessage(msg, '', 'en')}
      onClear={chat.clearChat}
      onMobileCommand={handleMobileCommand}
      isMobileConnected={isMobileConnected}
      title="AI Assistant"
    />
  );
}

export default App;
```

---

## Performance Optimization

### Voice Input
- **Lazy loading** of Web Speech API
- **Minimal re-renders** during interim updates
- **Efficient event handling** with refs

### Mobile Commands
- **Debounced typing** commands
- **Batch updates** to mobile
- **Efficient status polling**

### Real-Time Display
- **CSS animations** (no JS)
- **GPU acceleration** via transforms
- **Smooth 60fps** performance

---

## Accessibility

✅ **Voice Control**: Built-in accessibility for motor disabilities
✅ **Keyboard Shortcuts**: Full keyboard navigation
✅ **ARIA Labels**: Screen reader support
✅ **Status Indicators**: Visual + text feedback
✅ **Mobile Integration**: Control accessibility on device

---

## Advanced Features

### Custom Voice Language
```typescript
recognitionRef.current.lang = 'ja-JP'; // Japanese
recognitionRef.current.lang = 'es-ES'; // Spanish
```

### Command History
```typescript
const commands = [];
commands.push({ type: 'voice', text, timestamp });
commands.push({ type: 'mobile', action, timestamp });
```

### Command Queuing
```typescript
const commandQueue = [];
function queueCommand(cmd) {
  commandQueue.push(cmd);
  processQueue();
}
```

---

## Browser DevTools Tips

### Check Web Speech API
```javascript
// Check if available
console.log(window.webkitSpeechRecognition || window.SpeechRecognition);
```

### Debug Voice Recognition
```javascript
// Listen to events
recognition.onstart = () => console.log('started');
recognition.onresult = (e) => console.log('result', e);
recognition.onerror = (e) => console.log('error', e);
```

### Mobile Command Log
```javascript
// Intercept commands
window.addEventListener('mobile-command', (e) => {
  console.log('Mobile:', e.detail);
});
```

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Voice not working | Check microphone permission in browser |
| No interim results | Some browsers don't support interim results |
| Mobile not responding | Check connection status indicator |
| Keyboard shortcuts not working | Ensure focus is on window, not an input |
| Slow real-time feedback | Check network latency with mobile |

---

## Future Enhancements

- [ ] Voice language detection
- [ ] Custom voice commands
- [ ] Command history and replay
- [ ] Gesture recognition from mobile
- [ ] Haptic feedback integration
- [ ] Voice profile training
- [ ] Multi-language support
- [ ] Offline fallback mode
