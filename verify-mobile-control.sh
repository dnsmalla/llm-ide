#!/bin/bash

# LLM IDE Mobile Control Verification Script
# This script checks that all components are correctly installed and configured

echo "🔍 LLM IDE Mobile Control Verification"
echo "======================================"

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Counter
PASS=0
FAIL=0
WARN=0

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

# Warning function
test_warn() {
    local description="$1"
    local command="$2"

    echo -n "Testing: $description... "
    if eval "$command" > /dev/null 2>&1; then
        echo -e "${GREEN}✅ PASS${NC}"
        ((PASS++))
    else
        echo -e "${YELLOW}⚠️  WARN${NC} (manual verification required)"
        ((WARN++))
    fi
}

echo ""
echo "📡 LLM IDE Server Checks"
echo "-------------------------"
test_check "Server health endpoint" "curl -sf http://127.0.0.1:3456/health"
test_check "Server port listening" "lsof -i :3456"
test_check "Server process running" "pgrep -f 'node.*server.mjs'"

echo ""
echo "🤖 Computer Agent Checks"
echo "-------------------------"
AGENT_DIR="$HOME/Desktop/auto_sys/swift_apps/auto_swift_aicontrol/services/computer-agent"
test_check "Agent directory exists" "test -d $AGENT_DIR"
test_check "Agent package.json exists" "test -f $AGENT_DIR/package.json"
test_check "Agent index.ts exists" "test -f $AGENT_DIR/src/index.ts"
test_check "Agent server.ts exists" "test -f $AGENT_DIR/src/server.ts"
test_check "Agent llmide-client.ts exists" "test -f $AGENT_DIR/src/llmide-client.ts"
test_check "Agent command-handler.ts exists" "test -f $AGENT_DIR/src/command-handler.ts"
test_check "Agent screen-capture.ts exists" "test -f $AGENT_DIR/src/screen-capture.ts"
test_check "Agent mac-control.ts exists" "test -f $AGENT_DIR/src/mac-control.ts"
test_check "Agent .env exists" "test -f $AGENT_DIR/.env"

if [ -f "$AGENT_DIR/.env" ]; then
    test_check "Agent PORT configured" "grep -q 'PORT=' $AGENT_DIR/.env"
    test_check "Agent PIN configured" "grep -q 'PIN=' $AGENT_DIR/.env"
    test_check "Agent LLMIDE_URL configured" "grep -q 'LLMIDE_URL=' $AGENT_DIR/.env"
else
    echo -e "${YELLOW}⚠️  Skipping .env content checks (file not found)${NC}"
fi

# Test if agent is running
if pgrep -f "node.*computer-agent" > /dev/null; then
    test_check "Agent process running" "true"
    test_check "Agent port listening" "lsof -i :3006"
else
    echo -e "${YELLOW}⚠️  Agent not running (start with: cd $AGENT_DIR && npm start)${NC}"
fi

echo ""
echo "📱 iOS App Checks"
echo "-------------------------"
IOS_DIR="$HOME/Desktop/auto_sys/swift_apps/auto_swift_aicontrol/apps/ios/MyApp"
test_check "iOS app directory exists" "test -d $IOS_DIR"
test_check "iOS Xcode project exists" "test -d $HOME/Desktop/auto_sys/swift_apps/auto_swift_aicontrol/apps/ios/MyApp.xcodeproj"
test_check "iOS MyAppApp.swift exists" "test -f $IOS_DIR/MyAppApp.swift"
test_check "iOS ContentView.swift exists" "test -f $IOS_DIR/Views/ContentView.swift"
test_check "iOS ControlService.swift exists" "test -f $IOS_DIR/Services/ControlService.swift"
test_check "iOS DeviceDiscovery.swift exists" "test -f $IOS_DIR/Services/DeviceDiscovery.swift"

echo ""
echo "📚 Documentation Checks"
echo "-------------------------"
LLM_IDE_DIR="$HOME/llm-ide"
test_check "QUICK_START.md exists" "test -f $LLM_IDE_DIR/QUICK_START.md"
test_check "QUICK_VERIFICATION.md exists" "test -f $LLM_IDE_DIR/QUICK_VERIFICATION.md"
test_check "compact-mobile-integration.md exists" "test -f $LLM_IDE_DIR/docs/compact-mobile-integration.md"
test_check "mobile-control-complete.md exists" "test -f $LLM_IDE_DIR/docs/mobile-control-complete.md"

echo ""
echo "🔒 Security & Permissions"
echo "-------------------------"
echo -e "${YELLOW}⚠️  Manual verification required:${NC}"
echo "  macOS - Screen Recording: System Settings → Privacy & Security → Screen Recording"
echo "  macOS - Accessibility: System Settings → Privacy & Security → Accessibility"
echo "  macOS - Enable for: Terminal or Node process"
echo "  iOS - Local Network: Settings → Privacy & Security → Local Network"
echo "  iOS - Enable for: MyApp"

echo ""
echo "📊 Summary"
echo "======================================"
echo -e "${GREEN}Passed: $PASS${NC}"
echo -e "${YELLOW}Warnings: $WARN${NC}"
echo -e "${RED}Failed: $FAIL${NC}"
echo "======================================"

if [ $FAIL -eq 0 ]; then
    echo ""
    echo -e "${GREEN}✅ All automated checks passed!${NC}"
    if [ $WARN -gt 0 ]; then
        echo ""
        echo -e "${YELLOW}⚠️  $WARN manual verification(s) required (see above)${NC}"
    fi
    echo ""
    echo "🚀 Next steps:"
    echo "1. Verify macOS permissions (Screen Recording + Accessibility)"
    echo "2. Start LLM IDE server: cd ~/llm-ide/extension && node server.mjs"
    echo "3. Start computer agent: cd ~/Desktop/auto_sys/swift_apps/auto_swift_aicontrol/services/computer-agent && npm start"
    echo "4. Open iOS app and test connection"
    exit 0
else
    echo ""
    echo -e "${RED}❌ $FAIL check(s) failed. Please review above.${NC}"
    echo ""
    echo "📖 Troubleshooting:"
    echo "- Server not running: cd ~/llm-ide/extension && node server.mjs"
    echo "- Agent missing: Check path $AGENT_DIR"
    echo "- iOS app missing: Check path $IOS_DIR"
    echo "- Documentation missing: Run from llm-ide directory"
    exit 1
fi