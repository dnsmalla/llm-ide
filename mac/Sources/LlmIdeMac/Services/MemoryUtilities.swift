import Foundation

/// Centralized memory operations (faults / Q&A). Single source of truth for:
/// - Loading/saving fault reports
/// - Listing memory files
/// - Batch operations with error recovery
/// - Status tracking & updates
/// - Common workflows (mark fixed, reopen, etc.)
///
/// Wraps `MemoryStore` with higher-level patterns and error handling.
struct MemoryUtilities {
    private let store: MemoryStore
    private let repoURL: URL
    private let logHandler: (String) -> Void

    init(store: MemoryStore, repoURL: URL, logHandler: ((String) -> Void)? = nil) {
        self.store = store
        self.repoURL = repoURL
        self.logHandler = logHandler ?? { _ in }
    }

    // MARK: - Initialization

    /// Initialize the memory directory structure if needed.
    /// Idempotent — safe to call multiple times.
    func initializeIfNeeded() throws {
        try store.seedIfMissing(in: repoURL)
        logHandler("Memory store initialized at \(repoURL.lastPathComponent)")
    }

    // MARK: - Fault Operations

    /// Load a fault report with error handling.
    /// Returns nil and logs the error if loading fails.
    func loadFault(at url: URL) -> FaultReport? {
        do {
            let fault = try store.loadFault(at: url)
            logHandler("Loaded fault: \(url.lastPathComponent)")
            return fault
        } catch {
            logHandler("Failed to load fault at \(url.lastPathComponent): \(error.localizedDescription)")
            return nil
        }
    }

    /// Load all faults, skipping any that fail to load.
    /// Returns faults that loaded successfully.
    func loadAllFaults() -> [FaultReport] {
        let urls = store.listFaults(at: repoURL)
        logHandler("Loading \(urls.count) faults...")
        let faults = urls.compactMap { loadFault(at: $0) }
        logHandler("Loaded \(faults.count) of \(urls.count) faults")
        return faults
    }

    /// Load faults filtered by status.
    func loadFaultsByStatus(_ status: FaultStatus) -> [(url: URL, fault: FaultReport)] {
        let urls = store.listFaults(at: repoURL)
        return urls.compactMap { url in
            guard let fault = loadFault(at: url) else { return nil }
            return fault.status == status ? (url, fault) : nil
        }
    }

    /// Mark a fault as fixed with optional verification message.
    func markFaultFixed(at url: URL, verify: String? = nil) throws {
        try store.markFixed(at: url, verify: verify)
        logHandler("Marked fault as fixed: \(url.lastPathComponent)")
    }

    /// Update fault status.
    func updateFaultStatus(at url: URL, to status: FaultStatus) throws {
        try store.updateFaultStatus(at: url, to: status)
        logHandler("Updated fault status to \(status): \(url.lastPathComponent)")
    }

    /// Reopen a closed fault.
    func reopenFault(at url: URL) throws {
        try updateFaultStatus(at: url, to: .open)
    }

    // MARK: - Q&A Operations

    /// Load all Q&A entries.
    func loadAllQA() -> [URL] {
        let urls = store.listQA(at: repoURL)
        logHandler("Found \(urls.count) Q&A entries")
        return urls
    }

    // MARK: - Common Workflows

    /// Load all open faults (active bugs to work on).
    func loadOpenFaults() -> [(url: URL, fault: FaultReport)] {
        return loadFaultsByStatus(.open)
    }

    /// Load all fixed faults (resolved bugs).
    func loadFixedFaults() -> [(url: URL, fault: FaultReport)] {
        return loadFaultsByStatus(.fixed)
    }

    /// Mark multiple faults as fixed.
    /// Continues even if individual operations fail.
    func markMultipleFaultsFixed(at urls: [URL]) -> (succeeded: Int, failed: Int) {
        var succeeded = 0
        var failed = 0
        for url in urls {
            do {
                try markFaultFixed(at: url)
                succeeded += 1
            } catch {
                logHandler("Failed to mark fault fixed: \(error.localizedDescription)")
                failed += 1
            }
        }
        logHandler("Marked \(succeeded) faults fixed, \(failed) failed")
        return (succeeded, failed)
    }

    /// Reopen faults that match a condition (e.g., regression detected).
    /// Returns count of reopened faults.
    func reopenFaultsMatching(_ predicate: (FaultReport) -> Bool) -> Int {
        let urls = store.listFaults(at: repoURL)
        var faultsWithURLs: [(URL, FaultReport)] = []
        for url in urls {
            if let fault = loadFault(at: url) {
                faultsWithURLs.append((url, fault))
            }
        }
        let toReopen = faultsWithURLs.filter { _, fault in
            predicate(fault) && fault.status == .fixed
        }
        var count = 0
        for (url, _) in toReopen {
            do {
                try reopenFault(at: url)
                count += 1
            } catch {
                logHandler("Failed to reopen fault: \(error.localizedDescription)")
            }
        }
        logHandler("Reopened \(count) faults")
        return count
    }

    // MARK: - Git Integration

    /// Get git diff of memory directory (shows what changed).
    func gitDiff() -> MemoryStore.GitDiff? {
        do {
            return try store.gitDiff(at: repoURL)
        } catch {
            logHandler("Failed to get git diff: \(error.localizedDescription)")
            return nil
        }
    }

    /// Checkout specific paths from git (discard memory changes).
    func discardChanges(paths: [String]) throws {
        try store.gitCheckout(at: repoURL, paths: paths)
        logHandler("Discarded changes in \(paths.count) files")
    }

    /// Discard all memory changes (reset to last commit).
    func discardAllChanges() throws {
        try store.gitCheckout(at: repoURL, paths: ["."])
        logHandler("Discarded all memory changes")
    }

    // MARK: - Diagnostics

    /// Get summary of memory state (open/fixed fault counts, etc.).
    func getSummary() -> MemorySummary {
        let allFaults = loadAllFaults()
        let openCount = allFaults.filter { $0.status == .open }.count
        let fixedCount = allFaults.filter { $0.status == .fixed }.count
        let qa = loadAllQA()

        return MemorySummary(
            totalFaults: allFaults.count,
            openFaults: openCount,
            fixedFaults: fixedCount,
            qaEntries: qa.count,
            lastModified: Date()
        )
    }

    /// Print a human-readable summary.
    func printSummary() {
        let summary = getSummary()
        logHandler("""
        Memory Summary:
        - Faults: \(summary.totalFaults) total (\(summary.openFaults) open, \(summary.fixedFaults) fixed)
        - Q&A: \(summary.qaEntries) entries
        """)
    }
}

// MARK: - Types

/// Summary of memory state.
struct MemorySummary {
    let totalFaults: Int
    let openFaults: Int
    let fixedFaults: Int
    let qaEntries: Int
    let lastModified: Date
}
