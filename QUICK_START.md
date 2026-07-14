# Quick Start: Mobile Control for LLM IDE

> **3-step setup** to control LLM IDE from your iPhone - using existing production system

## Prerequisites

- ✅ macOS with **Screen Recording** & **Accessibility** permissions
- ✅ LLM IDE server installed
- ✅ Node.js 18+ installed
- ✅ iPhone on same Wi-Fi network
- ✅ Xcode (for iOS app)

## Step 1: Start LLM IDE Server

```bash
cd /Users/dinsmallade/llm-ide/extension
node server.mjs
```

**Keep this terminal open** - server runs at `http://127.0.0.1:3456`

Verify:
```bash
curl http://127.0.0.1:3456/health
```

## Step 2: Start Computer Agent

```bash
cd /Users/dinsmallade/Desktop/auto_sys/swift_apps/auto_swift_aicontrol/services/computer-agent
npm install
npm start
```

**Agent starts at `ws://localhost:3006`** with PIN authentication

You'll see:
```
================================
  AI Control Agent
================================
  Device : MacBook Pro
  PIN    : 123456  ← enter this in the app
  Port   : 3006
--------------------------------
  IP     : 192.168.1.100
  (iPhone will discover this Mac automatically)
================================
  Screen : OK (permission granted)
```

## Step 3: Open iOS App

```bash
cd /Users/dinsmallade/Desktop/auto_sys/swift_apps/auto_swift_aicontrol/apps/ios
open MyApp.xcodeproj
```

**Run on physical iPhone** (same Wi-Fi as Mac)

The app will automatically:
1. Discover your Mac via Bonjour
2. Show connection screen
3. Prompt for PIN entry
4. Connect and show remote desktop

## That's It! 🎉

You now have:
- ✅ **Remote desktop control** from iPhone
- ✅ **LLM IDE chat** on mobile
- ✅ **Screen streaming** (800×600 @ 10fps)
- ✅ **Touch control** (tap, drag, pinch, keyboard)
- ✅ **Meeting capture** during video calls
- ✅ **Code assistant** with file attachments

## What You Can Do

### Remote Desktop
- **Tap** = Left click
- **Double-tap** = Double-click
- **Long-press** = Right click
- **Drag** = Move mouse
- **Pinch** = Scroll
- **Keyboard button** = Full keyboard

### LLM IDE Features
- **Chat** tab: Ask questions, see responses
- **Meeting Agent** tab: AI assistant during meetings
- **Send images** with prompts
- **View history** of conversations

### Settings
- **Connections**: View paired devices
- **PIN**: Display/change your PIN
- **Preferences**: Theme, language, etc.

## Troubleshooting

### iOS app doesn't find Mac
- Ensure both on same Wi-Fi
- Check agent is running: `ps aux | grep node`
- Try manual IP entry if Bonjour fails

### Screen shows "PERMISSION DENIED"
```
System Settings → Privacy & Security → Screen Recording
→ Enable for Terminal/node
→ Restart agent
```

### Mouse/keyboard doesn't work
```
System Settings → Privacy & Security → Accessibility
→ Enable for Terminal/node
→ Restart agent
```

### LLM IDE features not working
- Ensure LLM IDE server running: `curl http://127.0.0.1:3456/health`
- Check agent config includes LLM IDE credentials
- Verify email/password in `.env`

## System Overview

```
iPhone (iOS App)
    │ Bonjour discovery + PIN auth
    ▼
Computer Agent (Node.js @ :3006)
    │ WebSocket
    ├──► Screen capture (screenshot-desktop)
    ├──► Input injection (nut-js)
    └──► LLM IDE API client (http://:3456)
    ▼
LLM IDE Server (:3456)
    └── Main backend server
```

## Key Files

### Computer Agent
```
~/Desktop/auto_sys/swift_apps/auto_swift_aicontrol/services/computer-agent/
├── src/index.ts              # Entry point
├── src/server.ts             # WebSocket server
├── src/llmide-client.ts     # LLM IDE API client
└── .env                      # Configuration (PIN, port, etc.)
```

### iOS App
```
~/Desktop/auto_sys/swift_apps/auto_swift_aicontrol/apps/ios/MyApp/
├── MyAppApp.swift           # App entry
├── Views/ContentView.swift  # Remote desktop UI
├── Services/ControlService.swift  # WebSocket client
└── Services/DeviceDiscovery.swift  # Bonjour discovery
```

## Security

✅ **Local-only** - All traffic stays on your Wi-Fi network  
✅ **No cloud** - No external API calls (except LLM IDE server)  
✅ **PIN auth** - 6-digit PIN required  
✅ **Session tokens** - LLM IDE uses JWT tokens  
✅ **Permissions** - Screen Recording + Accessibility required

## Performance

- **Connection**: < 3 seconds
- **Screen latency**: < 200ms  
- **Frame rate**: 10 fps
- **Bandwidth**: ~2-3 Mbps
- **Battery impact**: < 5%/hour

## Advanced Usage

### Change PIN
```bash
# Edit computer agent .env file
PIN=654321

# Restart agent
npm start
```

### Change Port
```bash
# Edit computer agent .env file
PORT=3007

# Restart agent
npm start
```

### Configure LLM IDE Credentials
```bash
# Edit computer agent .env file
LLMIDE_EMAIL=your@email.com
LLMIDE_PASSWORD=yourpassword

# Restart agent
npm start
```

## Related Documentation

- **Integration Plan**: `docs/compact-mobile-integration.md`
- **Mobile Plan**: `docs/mobile-control-plan.md`
- **Original System**: `~/Desktop/auto_sys/swift_apps/auto_swift_aicontrol/`

## Support

For issues:
1. Check agent logs in terminal
2. Check iOS app console in Xcode
3. Review troubleshooting section
4. Check original system README

---

**Status**: ✅ **Production-ready system, working today!**