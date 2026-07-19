import Foundation

/// Centralized git operations. Single source of truth for:
/// - Creating and checking out branches
/// - Committing with validation
/// - Pushing with retry logic
/// - Status checking & conflict detection
/// - Common workflows (feature branch, stash, checkout)
///
/// Uses `RepoManager.runGit` as the base, adds error handling + workflows.
struct GitUtilities {
    private let repoManager: RepoManager
    private let repoURL: URL
    private let logHandler: (String) -> Void

    init(repoManager: RepoManager, repoURL: URL, logHandler: ((String) -> Void)? = nil) {
        self.repoManager = repoManager
        self.repoURL = repoURL
        self.logHandler = logHandler ?? { _ in }
    }

    // MARK: - Status & Info

    /// Get current branch name.
    func currentBranch() async throws -> String {
        let output = try await repoManager.runGit(["rev-parse", "--abbrev-ref", "HEAD"], at: repoURL)
        return output.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines)
    }

    /// Check if there are uncommitted changes.
    func hasUncommittedChanges() async throws -> Bool {
        do {
            let output = try await repoManager.runGit(["status", "--porcelain"], at: repoURL)
            return !output.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        } catch {
            logHandler("Failed to check git status: \(error.localizedDescription)")
            return true // Assume dirty if we can't check
        }
    }

    /// Get the current HEAD commit SHA (short form).
    func currentCommitSha(short: Bool = true) async throws -> String {
        let format = short ? "--short" : "--no-patch"
        let output = try await repoManager.runGit(["rev-parse", format, "HEAD"], at: repoURL)
        return output.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines)
    }

    /// Get list of changed files in the working tree.
    func changedFiles() async throws -> [String] {
        let output = try await repoManager.runGit(["diff", "--name-only"], at: repoURL)
        let lines = output.split(separator: "\n", omittingEmptySubsequences: true)
        return lines.map { String($0).trimmingCharacters(in: CharacterSet.whitespaces) }
    }

    // MARK: - Commit Operations

    /// Stage all changes and commit with the given message.
    /// Validates message is non-empty.
    /// Returns the commit SHA on success.
    func commit(message: String, author: String? = nil) async throws -> String {
        let msg = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !msg.isEmpty else {
            throw GitError.emptyCommitMessage
        }

        // Stage changes
        logHandler("Staging changes...")
        _ = try await repoManager.runGit(["add", "-A"], at: repoURL)

        // Build commit command
        var args = ["commit", "-m", msg]
        if let author {
            args.append(contentsOf: ["--author", author])
        }

        logHandler("Committing: \(msg)")
        _ = try await repoManager.runGit(args, at: repoURL)

        // Return the commit SHA
        let sha = try await currentCommitSha()
        logHandler("Committed: \(sha)")
        return sha
    }

    /// Amend the last commit (stage changes first if needed).
    func amendCommit(message: String? = nil) async throws {
        var args = ["commit", "--amend"]
        if let message {
            args.append(contentsOf: ["-m", message])
        } else {
            args.append("--no-edit")
        }
        logHandler("Amending commit...")
        _ = try await repoManager.runGit(args, at: repoURL)
        logHandler("Commit amended")
    }

    // MARK: - Branch Operations

    /// Create a new branch from a reference (default: HEAD).
    /// Optionally checkout the branch immediately.
    func createBranch(_ name: String, from: String = "HEAD", checkout: Bool = false) async throws {
        logHandler("Creating branch: \(name)")
        _ = try await repoManager.runGit(["branch", name, from], at: repoURL)
        logHandler("Branch created: \(name)")

        if checkout {
            try await checkoutBranch(name)
        }
    }

    /// Checkout an existing branch.
    func checkoutBranch(_ name: String) async throws {
        logHandler("Checking out: \(name)")
        _ = try await repoManager.runGit(["checkout", name], at: repoURL)
        logHandler("Checked out: \(name)")
    }

    /// Create and immediately checkout a new branch (common workflow).
    func createAndCheckout(branch: String, from: String = "HEAD") async throws {
        try await createBranch(branch, from: from, checkout: true)
    }

    /// Delete a branch (local only).
    func deleteBranch(_ name: String, force: Bool = false) async throws {
        let flag = force ? "-D" : "-d"
        logHandler("Deleting branch: \(name)")
        _ = try await repoManager.runGit(["branch", flag, name], at: repoURL)
        logHandler("Branch deleted: \(name)")
    }

    // MARK: - Push/Pull Operations

    /// Push the current branch to remote (with retry).
    func push(branch: String? = nil, force: Bool = false, maxRetries: Int = 3) async throws {
        let targetBranch: String
        if let branch {
            targetBranch = branch
        } else {
            targetBranch = try await currentBranch()
        }
        var args = ["push", "origin"]
        if force { args.append("--force") }
        args.append(targetBranch)

        logHandler("Pushing branch: \(targetBranch)\(force ? " (--force)" : "")")
        try await retryableGit(args, maxRetries: maxRetries)
        logHandler("Pushed: \(targetBranch)")
    }

    /// Pull from remote with retry.
    func pull(maxRetries: Int = 3) async throws {
        logHandler("Pulling from remote...")
        try await retryableGit(["pull"], maxRetries: maxRetries)
        logHandler("Pull completed")
    }

    /// Fetch from remote.
    func fetch() async throws {
        logHandler("Fetching...")
        _ = try await repoManager.runGit(["fetch"], at: repoURL)
        logHandler("Fetch completed")
    }

    // MARK: - Cleanup Operations

    /// Stash all changes (useful before checking out different branches).
    func stash(message: String? = nil) async throws {
        var args = ["stash", "push"]
        if let message {
            args.append("-m")
            args.append(message)
        }
        logHandler("Stashing changes...")
        _ = try await repoManager.runGit(args, at: repoURL)
        logHandler("Changes stashed")
    }

    /// Discard all uncommitted changes (dangerous operation).
    func discardChanges() async throws {
        logHandler("⚠️  Discarding all changes...")
        _ = try await repoManager.runGit(["checkout", "--", "."], at: repoURL)
        _ = try await repoManager.runGit(["clean", "-fd"], at: repoURL)
        logHandler("All changes discarded")
    }

    // MARK: - Error Recovery

    /// Run a git command with automatic retry on transient failures.
    /// Useful for network operations (push, pull, fetch).
    private func retryableGit(
        _ args: [String],
        maxRetries: Int = 3,
        backoff: TimeInterval = 2.0
    ) async throws {
        var lastError: Error?
        for attempt in 1...maxRetries {
            do {
                _ = try await repoManager.runGit(args, at: repoURL)
                return
            } catch {
                lastError = error
                guard attempt < maxRetries else { throw error }
                let delay = backoff * Double(attempt)
                logHandler("Attempt \(attempt) failed, retrying in \(delay)s: \(error.localizedDescription)")
                try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            }
        }
        throw lastError ?? GitError.unknown
    }

    // MARK: - Common Workflows

    /// Create a feature branch, commit changes, and push (typical PR workflow).
    func featureBranchWorkflow(
        branchName: String,
        commitMessage: String,
        baseRef: String = "main"
    ) async throws -> String {
        // Create and checkout branch
        try await createAndCheckout(branch: branchName, from: baseRef)

        // Commit changes
        let sha = try await commit(message: commitMessage)

        // Push to remote
        try await push(branch: branchName)

        return sha
    }

    /// Safe checkout: stash changes first if there are uncommitted changes.
    func safeCheckout(_ branchName: String, stashMessage: String? = nil) async throws {
        if try await hasUncommittedChanges() {
            logHandler("Uncommitted changes found, stashing...")
            let msg = stashMessage ?? "Auto-stash before checkout to \(branchName)"
            try await stash(message: msg)
        }
        try await checkoutBranch(branchName)
    }
}

// MARK: - Errors

enum GitError: LocalizedError {
    case emptyCommitMessage
    case notGitRepository
    case uncommittedChanges
    case conflictDetected
    case pushFailed
    case unknown

    var errorDescription: String? {
        switch self {
        case .emptyCommitMessage:
            return "Commit message cannot be empty"
        case .notGitRepository:
            return "Not a git repository"
        case .uncommittedChanges:
            return "Uncommitted changes exist"
        case .conflictDetected:
            return "Git conflict detected"
        case .pushFailed:
            return "Failed to push to remote"
        case .unknown:
            return "Unknown git error"
        }
    }
}
