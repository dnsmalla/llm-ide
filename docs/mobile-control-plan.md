# Mobile Control Plan for LLM IDE

> **Goal**: Make llm-ide controllable from mobile devices (iOS/Android) with automatic backend startup, inspired by auto_swift_aicontrol and Google Remote Desktop.

## Vision

Transform llm-ide from a desktop-only system into a **hybrid mobile-desktop platform** where:

- **Mobile devices** act as controllers and viewers (iPhone, Android phones, tablets)
- **Desktop apps** (Mac/Windows) run the heavy workloads (server, capture, AI processing)
- **Automatic backend** that starts on-demand and manages connections
- **Local-first** with optional cloud relay for remote access

## System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Mobile Layer                           │
├─────────────────┬─────────────────┬───────────────────────────┤
│  iOS App        │  Android App    │  Web Dashboard (optional)  │
│  (SwiftUI)      │  (Kotlin/Flutter)│  (Next.js)                │
└────────┬────────┴────────┬────────┴───────────┬───────────────┘
         │                 │                    │
         │                 │                    │
    ┌────▼─────────────────▼────────────────────▼─────┐
    │              Auto-Backend Service                │
    │  (Auto-start, WebSocket relay, discovery)        │
    └────┬─────────────────────────────────────────────┘
         │
    ┌────▼─────────────────────────────────────────────┐
    │          Desktop Computer (Mac/Windows)          │
    ├─────────────────┬───────────────────────────────┤
    │  LLM IDE Server │  Computer Agent                │
    │  (127.0.0.1:3456)│  (WebSocket, screen, input)  │
    └─────────────────┴───────────────────────────────┘
```

## Key Components

### 1. Mobile Apps (iOS + Android)

**Core Features:**
- **Remote Desktop View** - Stream desktop screen to mobile (800×600 JPEG @ 10fps)
- **Touch Control** - Tap (click), drag (move), pinch (scroll), keyboard (full)
- **Meeting Control** - Start/stop recording, view live transcript
- **Knowledge Base Access** - Search meetings, view notes, browse plans
- **Code Assistant** - Send prompts, view responses, manage files
- **Issues Board** - View/edit issues, Kanban, Gantt chart
- **Settings** - Configure server connection, manage preferences

**Discovery & Connection:**
- Local network discovery (Bonjour/mDNS for iOS, NSD for Android)
- Manual IP/port entry as fallback
- QR code pairing for quick setup
- Persistent PIN-based auth (6-digit)

### 2. Auto-Backend Service

**Purpose**: Automatically start and manage the LLM IDE server when mobile apps connect.

**Features:**
- **Auto-start** - Launch `extension/server.mjs` when mobile connection detected
- **Health monitoring** - Check server status, restart if crashed
- **Port management** - Find available port if 3456 is occupied
- **Process lifecycle** - Graceful shutdown on disconnect
- **Log aggregation** - Stream server logs to mobile for debugging
- **Configuration** - Mobile apps can adjust server settings

**Implementation Options:**
```
Option A: Standalone Daemon (Recommended)
├── Runs on system startup
├── Monitors for mobile connections
└── Auto-starts/stops LLM IDE server

Option B: Embedded in Existing Mac App
├── Add auto-backend service to LlmIdeMac
├── Menu bar icon shows status
└── Manual start/stop controls

Option C: LaunchAgent/LaunchDaemon (macOS)
├── Native macOS integration
├── Auto-start on boot
└── System-level permissions
```

### 3. Computer Agent

**Purpose**: Bridge between mobile apps and desktop capabilities.

**Features:**
- **WebSocket Server** - Accept connections from mobile apps (port 3006)
- **Screen Capture** - Stream desktop screen via screenshot-desktop + sharp
- **Input Injection** - Control mouse/keyboard via @nut-tree-fork/nut-js
- **LLM IDE Proxy** - Relay API calls to local server (127.0.0.1:3456)
- **File Operations** - Read/write files with proper permissions
- **Meeting Capture** - Access captions via Accessibility API
- **Process Control** - Start/stop server, check status

### 4. Discovery & Authentication

**Local Discovery:**
```
1. Mobile app broadcasts Bonjour/mDNS query
2. Computer agent responds with:
   - Device name (e.g., "MacBook Pro")
   - IP address + port (default 3006)
   - Server status (running/stopped)
   - Required PIN
3. User taps device → enters PIN → connected
```

**Authentication:**
- **6-digit PIN** stored in `~/.llmide-mobile.json`
- Generated on first run, rotatable via settings
- Optional: Biometric auth (Face ID/Touch ID) after initial PIN
- Session timeout (default 30 minutes, configurable)

## Implementation Phases

### Phase 1: Foundation (Week 1-2)

**Computer Agent**
```
├── services/computer-agent/
│   ├── src/
│   │   ├── index.ts              # Entry point
│   │   ├── server.ts             # WebSocket server
│   │   ├── discovery.ts          # Bonjour/mDNS
│   │   ├── auth.ts               # PIN authentication
│   │   ├── llmide-proxy.ts       # Proxy to 127.0.0.1:3456
│   │   └── config.ts             # Configuration
│   ├── package.json
│   └── tsconfig.json
```

**Auto-Backend Service**
```
├── services/auto-backend/
│   ├── src/
│   │   ├── index.ts              # Entry point
│   │   ├── server-manager.ts     # Start/stop LLM IDE server
│   │   ├── health-monitor.ts     # Check server health
│   │   ├── port-manager.ts      # Find available ports
│   │   └── log-streamer.ts       # Stream logs to mobile
│   ├── package.json
│   └── tsconfig.json
```

**Deliverables:**
- Computer agent runs on Mac, accepts WebSocket connections
- Mobile apps can discover and connect via PIN
- Auto-backend starts LLM IDE server on demand
- Basic proxy to server API endpoints

### Phase 2: Mobile Apps - Core (Week 3-4)

**iOS App (SwiftUI)**
```
├── apps/ios/LlmIdeMobile/
│   ├── Views/
│   │   ├── ConnectView.swift        # Device discovery + PIN entry
│   │   ├── RemoteDesktopView.swift  # Screen stream + touch control
│   │   ├── MeetingView.swift        # Meeting capture control
│   │   ├── KbSearchView.swift       # Knowledge base search
│   │   └── SettingsView.swift       # Configuration
│   ├── Services/
│   │   ├── WebSocketService.swift   # WebSocket client
│   │   ├── DiscoveryService.swift   # Bonjour discovery
│   │   └── ApiService.swift         # API calls via proxy
│   └── Models/
│       ├── Device.swift
│       └── ConnectionStatus.swift
```

**Android App (Kotlin)**
```
├── apps/android/LlmIdeMobile/
│   ├── app/src/main/
│   │   ├── java/com/llmide/mobile/
│   │   │   ├── ui/
│   │   │   │   ├── ConnectActivity.kt
│   │   │   │   ├── RemoteDesktopActivity.kt
│   │   │   │   └── MeetingFragment.kt
│   │   │   ├── service/
│   │   │   │   ├── WebSocketService.kt
│   │   │   │   └── DiscoveryService.kt
│   │   │   └── model/
│   │   │       ├── Device.kt
│   │   │       └── ConnectionState.kt
```

**Deliverables:**
- iOS app discovers Mac, connects via PIN
- Android app discovers Mac, connects via PIN
- Remote desktop view with touch control
- Basic meeting capture control

### Phase 3: Advanced Features (Week 5-6)

**Screen Streaming & Input**
- High-performance JPEG compression (quality 55, 800×600)
- Adaptive frame rate (5-15 fps based on bandwidth)
- Gesture mapping (tap, drag, pinch, long-press)
- Full keyboard support (including special keys)

**Meeting Integration**
- Live transcript viewing on mobile
- Start/stop recording from mobile
- Speaker name management
- Language selection

**Knowledge Base Access**
- Full-text search across meetings
- View meeting notes and decisions
- Browse saved plans
- View issues and Gantt chart

**Code Assistant**
- Send prompts from mobile
- View streaming responses
- File attachments (photos, documents)
- Basic code editing

### Phase 4: Polish & Security (Week 7-8)

**Security**
- TLS/SSL for WebSocket (wss://)
- Certificate pinning for mobile apps
- Rate limiting on commands
- Audit logging for all actions
- Session timeout and auto-disconnect

**Performance**
- Adaptive video quality (3G/4G/Wi-Fi)
- Battery optimization for mobile
- Memory management for screen streaming
- Connection health monitoring

**UX/UI**
- Onboarding tutorial
- Connection status indicators
- Error messages and recovery
- Settings and preferences
- Accessibility support

### Phase 5: Remote Access (Optional, Week 9+)

**Cloud Relay**
```
For remote access when not on same network:

Mobile App ──HTTPS──► Cloud Relay ──WebSocket──► Computer Agent
                  (Optional)      (Tunneling)
```

**Features:**
- Optional cloud relay service
- End-to-end encryption
- NAT traversal (TURN server)
- Remote wake-on-LAN
- Push notifications

## Technical Specifications

### WebSocket Protocol

**Client → Server (Mobile → Computer)**
```json
{
  "id": "uuid",
  "type": "command|screen|input|api",
  "payload": { ... },
  "timestamp": "ISO8601"
}
```

**Server → Client (Computer → Mobile)**
```json
{
  "id": "uuid",
  "type": "frame|output|status|error",
  "payload": { ... },
  "timestamp": "ISO8601"
}
```

### Command Types

| Type | Payload | Description |
|------|---------|-------------|
| `start_stream` | `{ "quality": 55, "fps": 10 }` | Start screen streaming |
| `stop_stream` | `{}` | Stop screen streaming |
| `mouse_move` | `{ "x": 100, "y": 200 }` | Move mouse to position |
| `mouse_click` | `{ "button": "left|right", "double": false }` | Click mouse |
| `key_press` | `{ "key": "enter", "modifiers": [] }` | Press key |
| `start_recording` | `{}` | Start meeting capture |
| `stop_recording` | `{ "title": "Meeting Name" }` | Stop and save meeting |
| `api_call` | `{ "endpoint": "/kb/search", "params": {...} }` | Proxy API call |

### Dependencies

**Computer Agent:**
```json
{
  "dependencies": {
    "ws": "^8.18.0",
    "bonjour-service": "^1.4.1",
    "screenshot-desktop": "^1.15.3",
    "sharp": "^0.33.5",
    "@nut-tree-fork/nut-js": "^4.2.6",
    "node-fetch": "^3.3.2"
  }
}
```

**iOS App:**
```swift
// No external deps for WebSocket (URLSessionWebSocketTask)
import Network
import Foundation
```

**Android App:**
```kotlin
dependencies {
    implementation("org.java-websocket:Java-WebSocket:1.5.4")
    implementation("androidx.navigation:navigation-compose:2.7.6")
}
```

## Privacy & Security

### Data Handling
- **All processing local** - No cloud dependency for basic functionality
- **Screen data never stored** - Transient only, streamed directly to mobile
- **PIN authentication** - 6-digit, stored locally, rotatable
- **Session timeout** - Auto-disconnect after inactivity

### Permissions

**macOS:**
- Screen Recording (for capture)
- Accessibility (for input injection)
- Network (for WebSocket server)

**iOS:**
- Local Network (for Bonjour discovery)
- Camera/Microphone (optional, for attachments)

**Android:**
- ACCESS_WIFI_STATE (for discovery)
- INTERNET (for WebSocket)
- CAMERA (optional, for attachments)

## Performance Targets

| Metric | Target | Notes |
|--------|--------|-------|
| Connection time | < 3 seconds | Discovery → PIN → Connected |
| Screen latency | < 200ms | From action to visible response |
| Frame rate | 10 fps | Adaptive based on bandwidth |
| Bandwidth | ~2-3 Mbps | For 800×600 JPEG @ 10fps |
| Battery impact | < 5%/hour | Mobile device idle usage |
| Memory footprint | < 100 MB | Computer agent resident |

## Success Criteria

### MVP (Phase 1-2)
✅ Mobile apps discover and connect to desktop
✅ Remote desktop view with touch control
✅ Start/stop meeting recording from mobile
✅ View live transcript on mobile
✅ Auto-backend starts server on connection

### Full Feature (Phase 3-4)
✅ Complete knowledge base access on mobile
✅ Code assistant with prompt/response
✅ Issues board and Gantt chart viewing
✅ File operations and attachments
✅ Security (TLS, rate limiting, audit log)

### Production Ready (Phase 5)
✅ Polished UI/UX with onboarding
✅ Battery optimization
✅ Error handling and recovery
✅ Accessibility support
✅ Optional cloud relay for remote access

## Comparison with Google Remote Desktop

| Feature | Google Remote Desktop | LLM IDE Mobile |
|---------|---------------------|----------------|
| Use case | General remote desktop | Meeting + AI assistant |
| Discovery | Account-based | Local Bonjour + PIN |
| Latency | < 150ms | < 200ms |
| Resolution | Up to 4K | 800×600 (optimized) |
| Audio | Full audio | No audio (focus on captions) |
| Input | Full mouse/keyboard | Full mouse/keyboard |
| Local-only | No (requires cloud) | Yes (cloud optional) |
| Special features | None | Meeting capture, KB search, AI |

## Project Structure

```
llm-ide/
├── apps/
│   ├── ios/LlmIdeMobile/           # iOS app (SwiftUI)
│   └── android/LlmIdeMobile/       # Android app (Kotlin)
├── services/
│   ├── computer-agent/              # Computer WebSocket server
│   └── auto-backend/                # Auto-start service
├── mac/                             # Existing macOS app
├── extension/                       # Existing server + Chrome extension
└── docs/
    └── mobile-control-plan.md       # This document
```

## Next Steps

1. **Review and approval** of this plan
2. **Setup Phase 1** - Computer agent + auto-backend
3. **Prototype iOS app** - Basic connection and screen stream
4. **Test and iterate** - Validate performance and UX
5. **Proceed to Phase 2-3** - Full feature implementation

## Notes

- **Compact design** - Reuse existing LLM IDE server, add mobile layer
- **Auto backend** - Server starts on-demand, no manual intervention
- **Local-first** - Works without internet, cloud optional
- **Cross-platform** - iOS + Android support from day one
- **Privacy-focused** - No data leaves local network by default
