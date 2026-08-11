import Foundation

/// Copy for the "can't show repo data" empty state, shared by the Issues board
/// and the Gantt timeline so the two can't drift.
///
/// Both surfaces gate on a *token* being present, but both used to report the
/// same "No repository connected" regardless of why. When a repo was saved and
/// only the credential had gone missing, that message pointed users at the
/// wrong problem: the repository was right there in Settings, still active and
/// still cloned. Naming the actual gap is the difference between a 10-second
/// fix and a hunt.
struct RepoConnectionEmptyState {
    /// A repo/project is saved for at least one provider.
    let hasSavedRepo: Bool
    /// The keychain could not be read, so a token may exist but be invisible.
    let keychainUnreadable: Bool

    init(hasSavedRepo: Bool, keychainUnreadable: Bool) {
        self.hasSavedRepo = hasSavedRepo
        self.keychainUnreadable = keychainUnreadable
    }

    @MainActor
    init(config: AppConfig) {
        self.hasSavedRepo = !config.gitHubSavedRepos.isEmpty
            || !config.gitLabSavedProjects.isEmpty
        // `lastKnownHealthy`, not `isHealthy`: this runs inside a SwiftUI body
        // that can re-render freely, and `isHealthy` retries the keychain read
        // after a failure — which would re-prompt on every render.
        self.keychainUnreadable = !KeychainStore.lastKnownHealthy
    }

    var title: String {
        if keychainUnreadable { return "Can't read your saved credentials" }
        return hasSavedRepo ? "Access token missing" : "No repository connected"
    }

    /// - Parameter surface: what the user was trying to do, e.g. "browsing
    ///   issues" / "a timeline", folded into the call to action.
    func message(surface: String) -> String {
        if keychainUnreadable {
            return """
                macOS denied access to the LLM-IDE keychain item, so your saved \
                tokens can't be read. Your settings are intact — allow access \
                when prompted, or quit and reopen LLM-IDE, then try again.
                """
        }
        if hasSavedRepo {
            return """
                Your repository is still saved, but there's no access token to \
                reach it with. Re-enter your GitHub or GitLab Personal Access \
                Token in Settings to resume \(surface).
                """
        }
        return "Add a GitLab or GitHub Personal Access Token in Settings to start \(surface)."
    }
}
