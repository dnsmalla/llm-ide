import Foundation

/// Centralized issue/PR operations. Single source of truth for:
/// - Listing issues with common filters
/// - Creating issues
/// - Closing/updating issues
/// - Paginated fetches
/// - Error handling & retry logic
///
/// Prevents scattered reimplementation of the same patterns across services.
struct IssueUtilities {
    private let client: RepoBackend
    private let projectId: String
    private let logHandler: (String) -> Void

    init(client: RepoBackend, projectId: String, logHandler: ((String) -> Void)? = nil) {
        self.client = client
        self.projectId = projectId
        self.logHandler = logHandler ?? { _ in }
    }

    // MARK: - List Operations

    /// Fetch all issues matching filter, handling pagination automatically.
    /// Stops when a page returns < 10 items (indicating end of results).
    func fetchAllIssues(filter: RepoIssueFilter, maxPages: Int = 20) async throws -> [RepoIssue] {
        var out: [RepoIssue] = []
        for page in 1...maxPages {
            let batch = try await client.listIssues(projectId: projectId, filter: filter, page: page)
            out.append(contentsOf: batch)
            // Empty page = nothing more. Small page (< 10) also = end.
            if batch.count < 10 { break }
            logHandler("Fetched page \(page): \(batch.count) issues")
        }
        logHandler("Fetched \(out.count) total issues")
        return out
    }

    /// Fetch only open issues (common case).
    func fetchOpenIssues(maxPages: Int = 20) async throws -> [RepoIssue] {
        let filter = RepoIssueFilter(state: .opened, search: "", labelName: "")
        return try await fetchAllIssues(filter: filter, maxPages: maxPages)
    }

    /// Fetch issues by state: opened, closed, or all.
    func fetchByState(_ state: RepoIssueFilter.IssueState, maxPages: Int = 20) async throws -> [RepoIssue] {
        let filter = RepoIssueFilter(state: state, search: "", labelName: "")
        return try await fetchAllIssues(filter: filter, maxPages: maxPages)
    }

    // MARK: - Create Operations

    /// Create an issue with standard payload structure.
    /// Returns the created issue or throws on error.
    func createIssue(
        title: String,
        body: String = "",
        labels: [String] = [],
        assigneeIds: [String] = []
    ) async throws -> RepoIssue {
        var payload = RepoIssuePayload()
        payload.title = title
        payload.body = body
        payload.labels = labels
        payload.assigneeIds = assigneeIds.isEmpty ? nil : assigneeIds
        logHandler("Creating issue: \(title)")
        let issue = try await client.createIssue(projectId: projectId, payload: payload)
        logHandler("Created issue #\(issue.number)")
        return issue
    }

    // MARK: - Update Operations

    /// Close an issue.
    /// Idempotent: if already closed, does nothing.
    func closeIssue(_ issue: RepoIssue) async throws {
        guard issue.isOpen else {
            logHandler("Issue #\(issue.number) already closed, skipping")
            return
        }
        var payload = RepoIssuePayload()
        payload.stateChange = .close
        logHandler("Closing issue #\(issue.number)")
        _ = try await client.updateIssue(projectId: projectId, number: issue.number, payload: payload)
        logHandler("Closed issue #\(issue.number)")
    }

    /// Reopen a closed issue.
    func reopenIssue(_ issue: RepoIssue) async throws {
        guard !issue.isOpen else {
            logHandler("Issue #\(issue.number) already open, skipping")
            return
        }
        var payload = RepoIssuePayload()
        payload.stateChange = .reopen
        logHandler("Reopening issue #\(issue.number)")
        _ = try await client.updateIssue(projectId: projectId, number: issue.number, payload: payload)
        logHandler("Reopened issue #\(issue.number)")
    }

    /// Update issue title, body, or labels.
    func updateIssue(
        _ issue: RepoIssue,
        title: String? = nil,
        body: String? = nil,
        labels: [String]? = nil,
        assigneeIds: [String]? = nil
    ) async throws -> RepoIssue {
        var payload = RepoIssuePayload()
        if let title { payload.title = title }
        if let body { payload.body = body }
        if let labels { payload.labels = labels }
        if let assigneeIds { payload.assigneeIds = assigneeIds.isEmpty ? nil : assigneeIds }
        logHandler("Updating issue #\(issue.number)")
        return try await client.updateIssue(projectId: projectId, number: issue.number, payload: payload)
    }

    // MARK: - Common Workflows

    /// Auto-close an issue after code merge.
    /// Idempotent: if already closed, does nothing.
    func closeAfterMerge(_ issue: RepoIssue, commitSha: String? = nil) async throws {
        guard issue.isOpen else {
            logHandler("Issue #\(issue.number) already closed, skipping")
            return
        }
        try await closeIssue(issue)
    }

    /// Find and reopen issue if it's stale.
    /// Returns true if reopened, false if already open.
    func reopenIfStale(_ issue: RepoIssue, reason: String) async throws -> Bool {
        guard !issue.isOpen else {
            logHandler("Issue #\(issue.number) already open")
            return false
        }
        logHandler("Reopening stale issue #\(issue.number): \(reason)")
        try await reopenIssue(issue)
        return true
    }

    // MARK: - Error Recovery

    /// Retry an operation up to `maxAttempts` times with exponential backoff.
    /// Useful for transient API failures.
    func retry<T>(
        maxAttempts: Int = 3,
        backoff: TimeInterval = 1.0,
        operation: () async throws -> T
    ) async throws -> T {
        var lastError: Error?
        for attempt in 1...maxAttempts {
            do {
                return try await operation()
            } catch {
                lastError = error
                guard attempt < maxAttempts else { throw error }
                let delay = backoff * Double(attempt)
                logHandler("Attempt \(attempt) failed, retrying in \(delay)s: \(error.localizedDescription)")
                try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            }
        }
        throw lastError ?? NSError(domain: "IssueUtilities", code: -1, userInfo: nil)
    }
}
