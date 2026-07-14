# Mobile Control System Verification Guide

> Comprehensive checks to ensure all features are correctly implemented and working

## Quick Verification (2 minutes)

### 1. Check Services Running
```bash
# Terminal 1: LLM IDE server
curl http://127.0.0.1:3456/health
# Expected: {"status":"ok",...}

# Terminal 2: Computer agent  
curl http://localhost:3006/info
# Expected: {"agent":"ai-control", "status":"running",...}
```

### 2. Check Bonjour Advertising
```bash
dns-sd -B _aicontrol._tcp local
# Expected: Finds "AI Control" service on your network
```

### 3. Check Required Files Exist
```bash
# Computer agent files
test -f ~/Desktop/auto_sys/swift_apps/auto_swift_aicontrol/services/computer-agent/src/index.ts && echo "✅ index.ts exists"
test -f ~/Desktop/auto_sys/swift_apps/auto_swift_aicontrol/services/computer-agent/src/server.ts && echo "✅ server.ts exists"
test -f ~/Desktop/auto_sys/swift_apps/auto_swift_aicontrol/services/computer-agent/src/llmide-client.ts && echo "✅ llmide-client.ts exists"

# iOS app files
test -d ~/Desktop/auto_sys/swift_apps/auto_swift_aicontrol/apps/ios/MyApp && echo "✅ iOS app exists"
```

## Component Verification

### ✅ LLM IDE Server

**Location:** `~/llm-ide/extension/server.mjs`

**Checks:**
```bash
# 1. Server running
curl http://127.0.0.1:3456/health
# Expected: {"status":"ok","version":"3.0.0","apiVersion":18,...}

# 2. Required endpoints exist
curl http://127.0.0.1:3456/api/endpoints
# Expected: List of all available endpoints

# 3. Authentication working
curl -X POST http://127.0.0.1:3456/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"password"}'
# Expected: JWT token in response

# 4. KB agent endpoint
curl -X POST http://127.0.0.1:3456/kb/agent/ask \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"prompt":"test"}'
# Expected: Agent response
```

**Verification Checklist:**
- [ ] Server responds to health check
- [ ] Server port 3456 is listening
- [ ] All required endpoints present
- [ ] Authentication generates JWT tokens
- [ ] KB agent endpoint responds
- [ ] Server logs show no errors
- [ ] Database is accessible

### ✅ Computer Agent

**Location:** `~/Desktop/auto_sys/swift_apps/auto_swift_aicontrol/services/computer-agent/`

**Checks:**
```bash
cd ~/Desktop/auto_sys/swift_apps/auto_swift_aicontrol/services/computer-agent

# 1. Package dependencies
npm list --depth=0
# Required packages:
# - screenshot-desktop
# - @nut-tree-fork/nut-js
# - ws
# - qrcode-terminal

# 2. Configuration file exists
test -f .env && echo "✅ .env exists" || echo "❌ .env missing"

# 3. Configuration values set
grep -q "PORT=3006" .env && echo "✅ PORT configured"
grep -q "PIN=" .env && echo "✅ PIN configured"
grep -q "LLMIDE_URL=http://127.0.0.1:3456" .env && echo "✅ LLMIDE_URL configured"

# 4. Source files present
test -f src/index.ts && echo "✅ index.ts exists"
test -f src/server.ts && echo "✅ server.ts exists"
test -f src/llmide-client.ts && echo "✅ llmide-client.ts exists"
test -f src/command-handler.ts && echo "✅ command-handler.ts exists"
test -f src/screen-capture.ts && echo "✅ screen-capture.ts exists"
test -f src/mac-control.ts && echo "✅ mac-control.ts exists"

# 5. Agent starts successfully
npm start &
AGENT_PID=$!
sleep 3
ps -p $AGENT_PID && echo "✅ Agent running" || echo "❌ Agent failed to start"
kill $AGENT_PID 2>/dev/null
```

**Verification Checklist:**
- [ ] All dependencies installed
- [ ] .env file exists with required config
- [ ] PORT configured (default: 3006)
- [ ] PIN configured (6-digit)
- [ ] LLMIDE_URL configured (http://127.0.0.1:3456)
- [ ] All source files present
- [ ] Agent starts without errors
- [ ] WebSocket server binds to port 3006
- [ ] Bonjour service advertises on _aicontrol._tcp
- [ ] PIN is displayed in terminal on startup

### ✅ iOS App

**Location:** `~/Desktop/auto_sys/swift_apps/auto_swift_aicontrol/apps/ios/MyApp/`

**Checks:**
```bash
cd ~/Desktop/auto_sys/swift_apps/auto_swift_aicontrol/apps/ios

# 1. Xcode project exists
test -d MyApp.xcodeproj && echo "✅ Xcode project exists"

# 2. Key source files present
test -f MyApp/MyAppApp.swift && echo "✅ MyAppApp.swift exists"
test -f MyApp/Views/ContentView.swift && echo "✅ ContentView.swift exists"
test -f MyApp/Services/ControlService.swift && echo "✅ ControlService.swift exists"
test -f MyApp/Services/DeviceDiscovery.swift && echo "✅ DeviceDiscovery.swift exists"

# 3. Build project
xcodebuild -project MyApp.xcodeproj -scheme MyApp -configuration Debug clean build
# Expected: Build succeeds without errors

# 4. Check Info.plist for Local Network permission
grep -q "NSLocalNetworkUsageDescription" MyApp/Info.plist && echo "✅ Local Network permission declared"
```

**Verification Checklist:**
- [ ] Xcode project opens without errors
- [ ] All source files compile
- [ ] Local Network permission in Info.plist
- [ ] Bonjour discovery code present
- [ ] WebSocket client code present
- [ ] PIN authentication UI present
- [ ] Remote desktop view present
- [ ] Chat interface present
- [ ] Settings view present

## Feature Verification

### ✅ Remote Desktop Features

**Manual Testing:**
```bash
# 1. Start computer agent
cd ~/Desktop/auto_sys/swift_apps/auto_swift_aicontrol/services/computer-agent
npm start

# 2. Connect from iOS app
# - Open app on iPhone
# - Should discover computer automatically
# - Enter PIN when prompted
# - Should see remote desktop view

# 3. Test screen streaming
# - Should see Mac screen in iPhone
# - Updates in real-time (~10fps)
# - Resolution 800×600
```

**Verification Checklist:**
- [ ] iOS app discovers computer via Bonjour
- [ ] PIN authentication works
- [ ] Remote desktop view appears
- [ ] Screen streaming is smooth
- [ ] Frame rate is steady (~10fps)
- [ ] Screen latency is low (<200ms)
- [ ] Resolution is correct (800×600)

### ✅ Touch Control Features

**Manual Testing:**
```bash
# On iOS app with remote desktop active:
# - Tap screen → should click on Mac
# - Double-tap → should double-click
# - Long-press → should right-click
# - Drag → should move mouse
# - Pinch → should scroll
# - Keyboard button → should show keyboard
# - Type → should send keystrokes to Mac
```

**Verification Checklist:**
- [ ] Tap to click works
- [ ] Double-tap to double-click works
- [ ] Long-press to right-click works
- [ ] Drag to move mouse works
- [ ] Pinch to scroll works
- [ ] Keyboard appears on demand
- [ ] Keyboard input works
- [ ] Modifier keys (Shift, Cmd, etc.) work
- [ ] Special keys (Enter, Escape, etc.) work

### ✅ LLM IDE Integration Features

**Manual Testing:**
```bash
# 1. Test chat from mobile
# - Open iOS app
# - Go to Chat tab
# - Type question
# - Should see response from LLM IDE

# 2. Test image support
# - Take screenshot in iOS app
# - Send with prompt
# - Should process image correctly
```

**Verification Checklist:**
- [ ] Chat interface is accessible
- [ ] Can send text prompts
- [ ] Receive responses from LLM IDE
- [ ] Chat history is maintained
- [ ] Image attachment works
- [ ] Responses are formatted correctly
- [ ] Error handling works (server down, timeout, etc.)

### ✅ Meeting Features

**Manual Testing:**
```bash
# 1. Start meeting on Mac
# - Join Zoom/Teams meeting
# - Start LLM IDE recording

# 2. Test from iOS app
# - Should see live transcript
# - Can ask questions about meeting
# - AI co-pilot provides suggestions
```

**Verification Checklist:**
- [ ] Live transcript appears in iOS app
- [ ] Can start/stop recording from mobile
- [ ] Meeting questions are accessible
- [ ] AI co-pilot provides suggestions
- [ ] Can ask questions about meeting content
- [ ] Historical meetings are accessible

## Security Verification

### ✅ Local-Only Communication

**Checks:**
```bash
# 1. Check server binds to localhost only
netstat -an | grep 3456
# Expected: 127.0.0.1:3456 (NOT 0.0.0.0:3456)

# 2. Check agent binds to localhost only
netstat -an | grep 3006
# Expected: 127.0.0.1:3006 (NOT 0.0.0.0:3006)

# 3. Test no external connections
sudo lsof -i :3456 -P
sudo lsof -i :3006 -P
# Expected: Only local connections
```

**Verification Checklist:**
- [ ] Server binds to 127.0.0.1 only
- [ ] Agent binds to 127.0.0.1 only
- [ ] No external connections
- [ ] No cloud API calls (except LLM IDE)
- [ ] All traffic stays on local Wi-Fi

### ✅ Authentication

**Checks:**
```bash
# 1. Test PIN authentication
# - Try wrong PIN in iOS app
# - Should reject connection

# 2. Test session tokens
# - Check LLM IDE JWT token generation
# - Verify token includes expiration

# 3. Test connection timeout
# - Disconnect from network
# - Should timeout gracefully
```

**Verification Checklist:**
- [ ] PIN authentication works
- [ ] Wrong PIN is rejected
- [ ] JWT tokens are generated
- [ ] Tokens have expiration
- [ ] Connection timeout works
- [ ] Session refresh works

### ✅ Permissions

**macOS Permissions:**
```bash
# 1. Screen Recording
# System Settings → Privacy & Security → Screen Recording
# Should see: Terminal or Node
# Should be: ✅ Enabled

# 2. Accessibility
# System Settings → Privacy & Security → Accessibility  
# Should see: Terminal or Node
# Should be: ✅ Enabled
```

**iOS Permissions:**
```bash
# 1. Local Network
# Settings → Privacy & Security → Local Network
# Should see: MyApp
# Should be: ✅ Enabled
```

**Verification Checklist:**
- [ ] Screen Recording permission granted (macOS)
- [ ] Accessibility permission granted (macOS)
- [ ] Local Network permission granted (iOS)
- [ ] Permissions requested on first use
- [ ] App explains why permissions needed

## Performance Verification

### ✅ Connection Performance

**Checks:**
```bash
# 1. Bonjour discovery time
# - Start iOS app
# - Should discover computer in < 3 seconds

# 2. Connection time
# - Enter PIN
# - Should connect in < 2 seconds

# 3. Screen streaming latency
# - Perform action on Mac
# - Should see in iPhone in < 200ms
```

**Verification Checklist:**
- [ ] Bonjour discovery < 3 seconds
- [ ] Connection establishment < 2 seconds
- [ ] Screen latency < 200ms
- [ ] Frame rate steady at 10fps
- [ ] Bandwidth usage ~2-3 Mbps

### ✅ Resource Usage

**Checks:**
```bash
# 1. Computer agent memory
# - Check memory usage
ps aux | grep "node.*computer-agent"
# Expected: ~50-100MB resident

# 2. Computer agent CPU
# - Check CPU usage
top -pid $(pgrep -f "node.*computer-agent")
# Expected: <1% idle, 5-15% streaming

# 3. iOS battery impact
# - Use app for 10 minutes
# - Check battery usage
# Expected: < 5% per hour
```

**Verification Checklist:**
- [ ] Agent memory < 100MB
- [ ] Agent CPU < 1% idle
- [ ] Agent CPU < 15% during streaming
- [ ] iOS battery impact < 5%/hour
- [ ] No memory leaks over time

## Integration Verification

### ✅ LLM IDE ↔ Computer Agent Integration

**Checks:**
```bash
# 1. Test LLM IDE API client
curl -X POST http://127.0.0.1:3456/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"password"}'

# Use returned token in agent:
# Agent should:
# - Store token securely
# - Refresh on expiration
# - Include in API requests

# 2. Test agent → LLM IDE communication
# - From iOS app, send chat message
# - Should route: iOS → Agent → LLM IDE → Agent → iOS
# - Should see response in < 5 seconds
```

**Verification Checklist:**
- [ ] Agent can login to LLM IDE
- [ ] Agent stores JWT token
- [ ] Agent refreshes token on expiry
- [ ] Agent includes token in requests
- [ ] Chat requests complete successfully
- [ ] Image attachments work
- [ ] Error handling works (server down, timeout)

### ✅ Computer Agent ↔ iOS App Integration

**Checks:**
```bash
# 1. Test WebSocket connection
# - Connect from iOS app
# - Should see WebSocket open in agent logs
# - Should maintain connection

# 2. Test command flow
# iOS → Agent:
# - start_viewing command
# - stop_viewing command
# - remote_input command
# - llm_ask command

# Agent → iOS:
# - frame data (screen)
# - response data (chat)
# - status updates
# - error messages
```

**Verification Checklist:**
- [ ] WebSocket connection established
- [ ] Connection maintained over time
- [ ] start_viewing command works
- [ ] stop_viewing command works
- [ ] remote_input command works
- [ ] llm_ask command works
- [ ] frame data streams correctly
- [ ] response data returns correctly
- [ ] status updates sent
- [ ] error messages sent

## Automated Verification Script

Save this as `verify-mobile-control.sh`:

```bash
#!/bin/bash

echo "🔍 LLM IDE Mobile Control Verification"
echo "======================================"

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

# Counter
PASS=0
FAIL=0

# Test function
test_check() {
    local description="$1"
    local command="$2"
    
    echo -n "Testing: $description... "
    if eval "$command" > /dev/null 2>&1; then
        echo -e "${GREEN}✅ PASS${NC}"
        ((PASS++))
    else
        echo -e "${RED}❌ FAIL${NC}"
        ((FAIL++))
    fi
}

# LLM IDE Server
echo ""
echo "📡 LLM IDE Server Checks"
test_check "Server health endpoint" "curl -sf http://127.0.0.1:3456/health"
test_check "Server port listening" "lsof -i :3456"
test_check "Server process running" "pgrep -f 'node.*server.mjs'"

# Computer Agent
echo ""
echo "🤖 Computer Agent Checks"
AGENT_DIR="$HOME/Desktop/auto_sys/swift_apps/auto_swift_aicontrol/services/computer-agent"
test_check "Agent directory exists" "test -d $AGENT_DIR"
test_check "Agent index.ts exists" "test -f $AGENT_DIR/src/index.ts"
test_check "Agent server.ts exists" "test -f $AGENT_DIR/src/server.ts"
test_check "Agent llmide-client.ts exists" "test -f $AGENT_DIR/src/llmide-client.ts"
test_check "Agent .env exists" "test -f $AGENT_DIR/.env"
test_check "Agent port configured" "grep -q 'PORT=3006' $AGENT_DIR/.env"
test_check "Agent PIN configured" "grep -q 'PIN=' $AGENT_DIR/.env"
test_check "Agent LLMIDE_URL configured" "grep -q 'LLMIDE_URL=' $AGENT_DIR/.env"

# iOS App
echo ""
echo "📱 iOS App Checks"
IOS_DIR="$HOME/Desktop/auto_sys/swift_apps/auto_swift_aicontrol/apps/ios/MyApp"
test_check "iOS app directory exists" "test -d $IOS_DIR"
test_check "iOS MyAppApp.swift exists" "test -f $IOS_DIR/MyAppApp.swift"
test_check "iOS ContentView.swift exists" "test -f $IOS_DIR/Views/ContentView.swift"
test_check "iOS ControlService.swift exists" "test -f $IOS_DIR/Services/ControlService.swift"
test_check "iOS DeviceDiscovery.swift exists" "test -f $IOS_DIR/Services/DeviceDiscovery.swift"

# Permissions
echo ""
echo "🔒 Permissions Checks"
# Note: These require manual verification
echo -e "${GREEN}⚠️  Manual verification required:${NC}"
echo "  - Screen Recording (macOS): System Settings → Privacy & Security"
echo "  - Accessibility (macOS): System Settings → Privacy & Security"
echo "  - Local Network (iOS): Settings → Privacy & Security"

# Summary
echo ""
echo "======================================"
echo -e "${GREEN}Passed: $PASS${NC}"
echo -e "${RED}Failed: $FAIL${NC}"
echo "======================================"

if [ $FAIL -eq 0 ]; then
    echo -e "${GREEN}✅ All automated checks passed!${NC}"
    exit 0
else
    echo -e "${RED}❌ Some checks failed. Please review above.${NC}"
    exit 1
fi
```

**Usage:**
```bash
chmod +x verify-mobile-control.sh
./verify-mobile-control.sh
```

## Troubleshooting Failed Checks

### Server Not Running
```bash
# Check logs
tail -f ~/llm-ide/extension/server.stdout.log

# Restart server
cd ~/llm-ide/extension
node server.mjs
```

### Agent Not Running
```bash
# Check .env file
cat ~/Desktop/auto_sys/swift_apps/auto_swift_aicontrol/services/computer-agent/.env

# Restart agent
cd ~/Desktop/auto_sys/swift_apps/auto_swift_aicontrol/services/computer-agent
npm start
```

### iOS App Can't Discover Computer
```bash
# Check Bonjour advertising
dns-sd -B _aicontrol._tcp local

# Check agent logs for Bonjour errors

# Try manual IP entry in iOS app
```

### Screen Capture Not Working
```bash
# Verify Screen Recording permission
# System Settings → Privacy & Security → Screen Recording
# Enable for Terminal or Node process
```

### Input Not Working
```bash
# Verify Accessibility permission
# System Settings → Privacy & Security → Accessibility
# Enable for Terminal or Node process
```

### LLM IDE Features Not Working
```bash
# Check server is running
curl http://127.0.0.1:3456/health

# Check agent config
cat ~/Desktop/auto_sys/swift_apps/auto_swift_aicontrol/services/computer-agent/.env | grep LLMIDE

# Verify credentials are correct
```

## Continuous Verification

### Weekly Checks
- [ ] Run automated verification script
- [ ] Test mobile connection from iOS app
- [ ] Test screen streaming quality
- [ ] Test LLM IDE chat features
- [ ] Check for system updates

### Monthly Checks
- [ ] Review security permissions
- [ ] Check for dependency updates
- [ ] Test performance benchmarks
- [ ] Review logs for errors
- [ ] Update documentation if needed

## Summary

**Use this verification guide to:**
- ✅ Verify initial setup
- ✅ Troubleshoot issues
- ✅ Ensure system health
- ✅ Validate features
- ✅ Check performance
- ✅ Maintain security

**Automated script:** `./verify-mobile-control.sh`

**Manual verification:** Follow the checklists above for each component.

---

*For issues, refer to troubleshooting section or check `docs/compact-mobile-integration.md`*