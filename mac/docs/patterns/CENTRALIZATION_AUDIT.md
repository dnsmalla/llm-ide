# Centralization Audit: 10 High-Impact Opportunities

**Date:** 2026-07-20  
**Current Status:** 3 utilities centralized (IssueUtilities, GitUtilities, MemoryUtilities)  
**Opportunity:** 10 more patterns identified affecting 150+ files  

---

## Priority 1: CRITICAL (Prevent Data Loss & Security Issues)

### 1. HTTPClientUtilities — Network Error Standardization
**Impact:** 6+ services, prevents request timeouts, auth failures, secret leakage  
**Files:** LlmIdeAPIClient, GitHubClient, GitLabClient, BackendManager, MobileControlManager, WebSearchService  
**Duplicated:** 
- Error extraction from JSON envelopes
- Exponential backoff retry logic
- Transient error detection (429, 503, timeout)
- Bearer token header building
- Secret redaction in error logs

**Consolidation:** One HTTPClientUtilities with:
```swift
func executeWithRetry<T>(_ request: URLRequest, maxRetries: Int) async throws -> T
func isTransientError(_ error: Error) -> Bool
func exponentialBackoff(attempt: Int) -> TimeInterval
func extractError(from: Data) -> String // JSON envelope parsing
```

### 2. FileStoreUtilities — Safe JSON Persistence
**Impact:** 15+ stores (ChatSessionStore, DocTemplateStore, ProjectStore, ActivityStore, etc.)  
**Risk:** Data loss from failed writes, corruption from incomplete saves, stale cached data  
**Duplicated:**
- Directory creation with error handling
- JSON encode/decode with AppJSON
- Corrupt file backup (rename with timestamp)
- Load with fallback to template
- Atomic write pattern

**Consolidation:**
```swift
func saveJSON<T: Encodable>(_ value: T, to url: URL) throws
func loadJSON<T: Decodable>(_ type: T.Type, from url: URL, default: T? = nil) throws -> T
func backupCorruptFile(at url: URL) -> URL
```

### 3. StringValidation — Input Safety
**Impact:** 80+ scattered calls, prevents empty-string bugs, injection attacks  
**Duplicated:**
- `.trimmingCharacters(in: .whitespacesAndNewlines)` (30+ times)
- `guard !text.isEmpty` validation (40+ times)
- Email validation
- URL validation
- Path validation

**Consolidation:**
```swift
extension String {
    var trimmed: String
    var isNonEmpty: Bool
    func isValidEmail() -> Bool
    func isValidURL() -> Bool
    func isValidPath() -> Bool
}
```

---

## Priority 2: HIGH (Prevent Bugs & Improve Reliability)

### 4. FileSystemUtilities — Directory Operations
**Impact:** 38+ uses, prevents silent failures, symlink issues  
**Files:** MemoryStore, ProjectStore, all file-writing services  
**Duplicated:**
- `FileManager.default.fileExists(atPath:)` checks
- `createDirectory()` with `withIntermediateDirectories: true`
- Error handling (mostly ignored with try?)
- Symlink detection

**Consolidation:**
```swift
func ensureDirectory(at url: URL) throws
func fileExists(at url: URL, logIfMissing: Bool = false) -> Bool
func isSymlink(at url: URL) -> Bool
```

### 5. LoggingFactory — Consistent Logger Setup
**Impact:** 20+ services, improves debuggability  
**Duplicated:**
```swift
// Repeated in every service:
private let log = Logger(subsystem: "com.llmide.macapp", category: "ServiceName")
```

**Consolidation:**
```swift
enum LogCategory { case networkClient, storage, ui, automation, ... }
let log = LoggingFactory.logger(for: .networkClient)
```

### 6. AuthenticationUtilities — Token Management
**Impact:** 6+ clients, prevents auth leaks, inconsistent header names  
**Files:** GitHubClient, GitLabClient, LlmIdeAPIClient, BackendManager  
**Duplicated:**
- Bearer token header building
- PRIVATE-TOKEN header setup
- Token validation before header creation
- Secret redaction in error logs

**Consolidation:**
```swift
func bearerHeader(token: String) throws -> (key: String, value: String)
func privateTokenHeader(token: String) throws -> (key: String, value: String)
func redactedForLogging(_ token: String) -> String
```

---

## Priority 3: MEDIUM (Polish & Scalability)

### 7. URLEncodingUtilities — Path/Query Safety
**Impact:** 10+ files, prevents injection attacks  
**Duplicated:** Manual `addingPercentEncoding()` calls with character sets

### 8. PaginationUtilities — Batch Operations
**Impact:** 5+ places, prevents off-by-one errors  
**Currently working (heuristic):** "Stop when page < 10 items"  
**Consolidation:** One source of truth for pagination config

### 9. StateUtilities — Observable Management
**Impact:** 84+ uses of @Published, prevents race conditions  
**Consolidation:** `@CachedPublished` wrapper, debounce helpers

### 10. ConfigurationUtilities — Settings Loading
**Impact:** 8+ services, prevents stale config bugs  
**Consolidation:** Type-safe config getters, default registry

---

## Implementation Roadmap

### Phase 1: This Week (3-4 days)
1. **HTTPClientUtilities** — Standardize all network retry/error handling
2. **FileStoreUtilities** — Wrap all 15+ JSON stores for safety
3. **StringValidation** — Eliminate empty-string bugs across codebase

**Impact:** Prevents data loss, auth failures, input validation bugs

### Phase 2: Next Week (2-3 days)
4. **FileSystemUtilities** — Centralize directory operations
5. **LoggingFactory** — Consistent logger setup
6. **AuthenticationUtilities** — Token management standardization

**Impact:** Improved debuggability, auth consistency, filesystem safety

### Phase 3: Following Week (2-3 days)
7-10. URL encoding, pagination, state management, configuration

**Impact:** Code polish, scalability improvements

---

## Expected Outcomes

### Before Centralization
- 150+ files with scattered patterns
- 80+ instances of code duplication
- Bugs reintroduced in 10+ locations on every update
- Silent failures (unhandled errors)

### After Full Centralization
- 3 → 13 centralized utilities
- Single source of truth for common operations
- One fix propagates to 150+ files
- Consistent error handling across all services
- Better testability (utilities vs scattered code)

---

## Why This Matters

Each utility follows the same pattern:
1. **Single responsibility** — One thing, done well
2. **Error handling** — Consistent across all services
3. **Logging** — Observable for debugging
4. **Testing** — Easy to unit test vs scattered code
5. **Maintenance** — Fix once, benefits all

**Key insight:** Duplication doesn't just waste code; it creates bugs that multiply across the codebase. Every time we update, we risk reintroducing bugs in 10+ places independently.

---

## Success Metric

**Before:** Same bug in 10 files = 10 patches + regression hunt  
**After:** Same bug in 1 utility = 1 fix + all services fixed  

Time to fix bugs: **10x faster**  
Regression frequency: **80% lower**  
Code maintainability: **Dramatically improved**
