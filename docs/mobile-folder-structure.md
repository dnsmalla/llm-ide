# Mobile Control System - Systematic Folder Structure

> **Principle**: Follow existing llm-ide conventions, mirror auto_swift_aicontrol patterns, maintain clean separation of concerns.

## Root Level Structure

```
llm-ide/
├── apps/                           # NEW: Mobile applications
│   ├── ios/                        # NEW: iOS app (SwiftUI)
│   ├── android/                    # NEW: Android app (Kotlin)
│   └── web/                        # NEW: Web dashboard (optional)
├── services/                       # NEW: Backend services
│   ├── computer-agent/             # NEW: Computer WebSocket agent
│   ├── auto-backend/               # NEW: Auto-start service
│   └── cloud-relay/                # FUTURE: Optional cloud relay
├── extension/                      # EXISTING: Chrome extension + server
├── mac/                            # EXISTING: macOS app
├── docs/                           # EXISTING: Documentation
├── scripts/                        # EXISTING: Build/utility scripts
└── CLAUDE.md                       # EXISTING: Project guidance
```

## Directory Naming Conventions

- **kebab-case** for all directories and files
- **Plural** for directories containing multiple items (apps, services, agents)
- **Singular** for unique components (README, package.json)
- **Descriptive** names that indicate purpose (computer-agent, auto-backend)

## Component Structure Details

### 1. Apps Layer (`apps/`)

```
apps/
├── ios/                            # iOS mobile app
│   ├── LlmIdeMobile/              # Main Xcode project
│   │   ├── App/                   # SwiftUI app structure
│   │   │   ├── Views/             # UI views
│   │   │   │   ├── Connect/      # Connection & auth
│   │   │   │   ├── RemoteDesktop/# Screen streaming
│   │   │   │   ├── Meeting/      # Meeting control
│   │   │   │   ├── Knowledge/    # KB access
│   │   │   │   └── Settings/     # Configuration
│   │   │   ├── ViewModels/       # MVVM view models
│   │   │   ├── Models/           # Data models
│   │   │   ├── Services/         # Business logic
│   │   │   └── Resources/        # Assets, localization
│   │   ├── Tests/                # Unit tests
│   │   ├── README.md             # iOS-specific docs
│   │   └── Package.swift          # Swift package config
│   └── README.md                  # iOS overview
│
├── android/                        # Android mobile app
│   ├── LlmIdeMobile/              # Main Android project
│   │   ├── app/src/main/
│   │   │   ├── java/com/llmide/mobile/
│   │   │   │   ├── ui/           # Activities & Fragments
│   │   │   │   │   ├── connect/  # Connection & auth
│   │   │   │   │   ├── remote/   # Remote desktop
│   │   │   │   │   ├── meeting/  # Meeting control
│   │   │   │   │   ├── knowledge/# KB access
│   │   │   │   │   └── settings/ # Configuration
│   │   │   │   ├── service/      # Background services
│   │   │   │   ├── model/       # Data models
│   │   │   │   └── util/         # Utilities
│   │   │   ├── res/              # Android resources
│   │   │   └── AndroidManifest.xml
│   │   ├── build.gradle.kts       # Build configuration
│   │   ├── README.md             # Android-specific docs
│   │   └── proguard-rules.pro    # ProGuard config
│   └── README.md                  # Android overview
│
└── web/                            # Optional web dashboard
    ├── dashboard/                  # Next.js project
    │   ├── src/
    │   │   ├── app/               # App router pages
    │   │   ├── components/        # React components
    │   │   ├── lib/               # Utilities
    │   │   └── styles/            # CSS/styling
    │   ├── public/                # Static assets
    │   ├── package.json           # Dependencies
    │   ├── README.md              # Web-specific docs
    │   └── next.config.js         # Next.js config
    └── README.md                  # Web overview
```

### 2. Services Layer (`services/`)

```
services/
├── computer-agent/                 # Computer WebSocket agent
│   ├── src/                       # TypeScript source
│   │   ├── core/                  # Core functionality
│   │   │   ├── server.ts          # WebSocket server
│   │   │   ├── discovery.ts       # Bonjour/mDNS discovery
│   │   │   ├── auth.ts            # PIN authentication
│   │   │   └── config.ts          # Configuration management
│   │   ├── modules/               # Feature modules
│   │   │   ├── screen-capture/    # Screen streaming
│   │   │   │   ├── capture.ts     # screenshot-desktop wrapper
│   │   │   │   ├── compressor.ts  # sharp compression
│   │   │   │   └── stream.ts      # Stream management
│   │   │   ├── input-injector/   # Mouse/keyboard control
│   │   │   │   ├── mouse.ts       # nut-js mouse wrapper
│   │   │   │   ├── keyboard.ts   # nut-js keyboard wrapper
│   │   │   │   └── gestures.ts   # Gesture mapping
│   │   │   ├── llmide-proxy/      # LLM IDE server proxy
│   │   │   │   ├── proxy.ts       # HTTP proxy
│   │   │   │   ├── api-client.ts  # API wrapper
│   │   │   │   └── endpoints.ts   # Endpoint definitions
│   │   │   └── meeting-control/   # Meeting capture control
│   │   │       ├── capturer.ts    # Accessibility API wrapper
│   │   │       ├── recorder.ts    # Recording state
│   │   │       └── transcript.ts  # Transcript management
│   │   ├── types/                 # TypeScript types
│   │   │   ├── messages.ts        # Message protocols
│   │   │   ├── commands.ts        # Command definitions
│   │   │   └── config.ts          # Config types
│   │   ├── utils/                 # Utilities
│   │   │   ├── logger.ts          # Logging
│   │   │   ├── errors.ts          # Error handling
│   │   │   └── validation.ts      # Input validation
│   │   └── index.ts               # Entry point
│   ├── tests/                     # Tests
│   │   ├── unit/                  # Unit tests
│   │   ├── integration/           # Integration tests
│   │   └── e2e/                   # End-to-end tests
│   ├── dist/                      # Compiled output
│   ├── package.json              # Dependencies
│   ├── tsconfig.json             # TypeScript config
│   ├── README.md                 # Service documentation
│   └── .env.example              # Environment variables
│
├── auto-backend/                   # Auto-start service
│   ├── src/                       # TypeScript source
│   │   ├── core/                  # Core functionality
│   │   │   ├── manager.ts         # Service lifecycle
│   │   │   ├── monitor.ts         # Health monitoring
│   │   │   └── scheduler.ts       # Task scheduling
│   │   ├── modules/               # Feature modules
│   │   │   ├── server-control/    # LLM IDE server control
│   │   │   │   ├── launcher.ts    # Process launching
│   │   │   │   ├── watcher.ts     # File watching
│   │   │   │   └── port-manager.ts # Port management
│   │   │   ├── log-streamer/      # Log streaming
│   │   │   │   ├── tailer.ts      # Log tailing
│   │   │   │   └── formatter.ts   # Log formatting
│   │   │   └── config-sync/       # Config synchronization
│   │   │       ├── watcher.ts     # Config changes
│   │   │       └── applier.ts     # Config application
│   │   ├── types/                 # TypeScript types
│   │   ├── utils/                 # Utilities
│   │   └── index.ts               # Entry point
│   ├── tests/                     # Tests
│   ├── dist/                      # Compiled output
│   ├── package.json              # Dependencies
│   ├── tsconfig.json             # TypeScript config
│   └── README.md                 # Service documentation
│
└── cloud-relay/                    # FUTURE: Optional cloud relay
    ├── src/                       # TypeScript source
    ├── tests/                     # Tests
    ├── dist/                      # Compiled output
    ├── package.json              # Dependencies
    ├── tsconfig.json             # TypeScript config
    └── README.md                 # Service documentation
```

### 3. Documentation Structure (`docs/`)

```
docs/
├── mobile/                         # NEW: Mobile control docs
│   ├── overview.md                # System overview
│   ├── architecture.md            # Detailed architecture
│   ├── folder-structure.md        # This file
│   ├── api-reference.md           # WebSocket API reference
│   ├── security.md                # Security model
│   ├── performance.md             # Performance guidelines
│   └── troubleshooting.md         # Common issues
│
├── how-to/                         # EXISTING: How-to guides
│   ├── mobile/                    # NEW: Mobile how-to
│   │   ├── setup-ios-device.md   # iOS device setup
│   │   ├── setup-android-device.md# Android device setup
│   │   ├── configure-pairing.md   # Device pairing
│   │   ├── remote-desktop.md     # Remote desktop usage
│   │   └── mobile-meeting.md     # Mobile meeting control
│   └── ...
│
├── reference/                      # EXISTING: Reference docs
│   ├── mobile/                    # NEW: Mobile reference
│   │   ├── mobile-api.md         # Mobile API reference
│   │   ├── websocket-protocol.md # WebSocket protocol
│   │   ├── command-reference.md  # Command reference
│   │   └── configuration.md      # Configuration options
│   └── ...
│
└── explanation/                    # EXISTING: Explanation docs
    ├── mobile/                    # NEW: Mobile explanations
    │   ├── discovery-protocol.md # How discovery works
    │   ├── screen-streaming.md   # How streaming works
    │   ├── security-model.md     # Why this security model
    │   └── performance-design.md # Performance tradeoffs
    └── ...
```

### 4. Scripts Structure (`scripts/`)

```
scripts/
├── mobile/                         # NEW: Mobile-specific scripts
│   ├── setup-ios-device.sh        # iOS device setup helper
│   ├── setup-android-device.sh    # Android device setup helper
│   ├── test-mobile-connection.sh  # Test mobile connection
│   ├── generate-pins.ts           # PIN generation utility
│   └── cleanup-mobile.sh          # Mobile cleanup utility
└── ...
```

## File Naming Conventions

### TypeScript Files
- **kebab-case.ts** for implementation files
- **kebab-case.types.ts** for type definitions
- **kebab-case.test.ts** for test files
- **index.ts** for module exports

### Swift Files
- **PascalCase.swift** for SwiftUI views
- **PascalCase+Extension.swift** for extensions
- **ProtocolName.swift** for protocols

### Kotlin Files
- **PascalCase.kt** for classes
- **ObjectName.kt** for objects/singletons
- **feature-name.kt** for functions

### Markdown Files
- **kebab-case.md** for all documentation
- **README.md** for directory overview (exception)

## Configuration Files

### Service Root Config
```
service-name/
├── package.json          # Dependencies & scripts
├── tsconfig.json         # TypeScript config
├── .env.example          # Environment template
├── README.md             # Service documentation
├── .gitignore            # Git ignore patterns
└── eslint.config.js      # ESLint config (if needed)
```

### Mobile App Config
```
app-name/
├── README.md             # App overview
├── Package.swift/podspec # Dependency management
├── build.gradle.kts      # Build config (Android)
└── .gitignore            # Git ignore patterns
```

## Import Path Conventions

### TypeScript
```typescript
// Internal imports - use relative paths
import { MessageHandler } from '../core/server';
import { CaptureModule } from '../modules/screen-capture/capture';

// Type imports - group separately
import type { WebSocketMessage } from '../types/messages';
```

### Swift
```swift
// Internal imports - use module name
import LlmIdeMobile
import SwiftUI

// External libraries
import Network
```

### Kotlin
```kotlin
// Internal imports - use package structure
import com.llmide.mobile.ui.connect
import com.llmide.mobile.service

// External libraries
import androidx.lifecycle.ViewModel
```

## README Template

Each major component should have a README following this structure:

```markdown
# Component Name

> Brief description of what this component does

## Purpose
- Why this component exists
- What problem it solves
- Key responsibilities

## Quick Start
### Prerequisites
### Installation
### Running

## Architecture
### Structure
### Key Files
### Data Flow

## API Reference
### Public Interfaces
### Message Types
### Configuration

## Development
### Adding Features
### Testing
### Debugging

## Deployment
### Build Process
### Environment Variables
### Monitoring

## Troubleshooting
### Common Issues
### Debug Mode
### Log Location
```

## Dependencies Management

### Service Dependencies
- **Root-level** for shared tooling (eslint, typescript)
- **Service-level** for specific dependencies
- **Peer dependencies** clearly specified

### Mobile Dependencies
- **iOS**: Swift Package Manager
- **Android**: Gradle
- **Web**: npm

## Build Artifacts

### Services
```
dist/
├── index.js              # Main entry point
├── core/                 # Compiled core
├── modules/              # Compiled modules
├── types/                # Compiled types
└── utils/                # Compiled utils
```

### Mobile Apps
```
# iOS
build/
└── LlmIdeMobile.app/

# Android
app/build/outputs/
└── apk/
```

## Testing Structure

```
component/
├── tests/
│   ├── unit/             # Fast, isolated tests
│   ├── integration/      # Component integration
│   └── e2e/              # Full workflow tests
│
└── test-utils/           # Shared test utilities
    ├── fixtures/         # Test data
    ├── mocks/           # Mock implementations
    └── helpers/         # Test helpers
```

## Environment Configuration

### Service Environment
```
.env                      # Local development (gitignored)
.env.example              # Template (tracked)
.env.production           # Production secrets (gitignored)
```

### Mobile Environment
```
# iOS
xcconfig files for different configurations

# Android
build.gradle.kts productFlavors
```

## Summary

**Key Principles:**
1. **Consistent naming** - kebab-case for directories/files, PascalCase for types
2. **Clear separation** - Core vs Modules vs Types vs Utils
3. **Follow patterns** - Mirror llm-ide and auto_swift_aicontrol conventions
4. **Documentation first** - README in every major directory
5. **Test isolation** - Separate test directory with proper structure
6. **Config management** - Clear .env.example patterns
7. **Build artifacts** - Separate dist/build directories (gitignored)

**Before creating any files:**
1. Check if similar structure exists
2. Follow naming conventions exactly
3. Create appropriate README.md
4. Add .gitignore patterns if needed
5. Consider test location upfront
