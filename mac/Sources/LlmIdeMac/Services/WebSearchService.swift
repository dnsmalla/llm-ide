import Foundation
import Combine

/// Client-side web search enhancements: history, caching, multiple sources
final class WebSearchService: ObservableObject {
    @Published var searchHistory: [WebSearchEntry] = []
    @Published var cachedResults: [String: WebSearchResult] = [:]

    private let maxHistorySize = 50
    private let cacheDuration: TimeInterval = 3600 // 1 hour

    struct WebSearchEntry: Identifiable, Codable {
        let id: UUID
        let query: String
        let timestamp: Date
        let resultCount: Int

        init(id: UUID = UUID(), query: String, timestamp: Date = Date(), resultCount: Int) {
            self.id = id
            self.query = query
            self.timestamp = timestamp
            self.resultCount = resultCount
        }
    }

    struct WebSearchResult: Codable {
        let query: String
        let results: [SearchHit]
        let cachedAt: Date
        let sourceUrls: [String]
        let cacheDuration: TimeInterval

        init(query: String, results: [SearchHit], cachedAt: Date, sourceUrls: [String], cacheDuration: TimeInterval = 3600) {
            self.query = query
            self.results = results
            self.cachedAt = cachedAt
            self.sourceUrls = sourceUrls
            self.cacheDuration = cacheDuration
        }

        func isExpired() -> Bool {
            Date().timeIntervalSince(cachedAt) > cacheDuration
        }
    }

    struct SearchHit: Codable {
        let url: String
        let title: String
        let snippet: String
        let source: String
    }

    // MARK: - Search History

    func addToHistory(query: String, resultCount: Int) {
        let entry = WebSearchEntry(query: query, resultCount: resultCount)
        searchHistory.insert(entry, at: 0)

        // Keep only recent entries
        if searchHistory.count > maxHistorySize {
            searchHistory = Array(searchHistory.prefix(maxHistorySize))
        }

        saveHistory()
    }

    func clearHistory() {
        searchHistory = []
        saveHistory()
    }

    private func saveHistory() {
        // Persist to UserDefaults for session recovery
        if let data = try? JSONEncoder().encode(searchHistory) {
            UserDefaults.standard.set(data, forKey: "webSearchHistory")
        }
    }

    private func loadHistory() {
        if let data = UserDefaults.standard.data(forKey: "webSearchHistory"),
           let decoded = try? JSONDecoder().decode([WebSearchEntry].self, from: data) {
            searchHistory = decoded
        }
    }

    // MARK: - Result Caching

    func cacheResults(query: String, results: [SearchHit], sources: [String]) {
        let result = WebSearchResult(
            query: query,
            results: results,
            cachedAt: Date(),
            sourceUrls: sources,
            cacheDuration: cacheDuration
        )
        cachedResults[query.lowercased()] = result

        // Clean expired entries
        let expiredKeys = cachedResults.filter { $0.value.isExpired() }.map { $0.key }
        for key in expiredKeys {
            cachedResults.removeValue(forKey: key)
        }
    }

    func getCachedResults(for query: String) -> WebSearchResult? {
        let cached = cachedResults[query.lowercased()]
        return cached?.isExpired() == true ? nil : cached
    }

    // MARK: - Enhanced Search

    func searchWeb(query: String) async throws -> [SearchHit] {
        // Check cache first
        if let cached = getCachedResults(for: query) {
            addToHistory(query: query, resultCount: cached.results.count)
            return cached.results
        }

        // For now, this is a placeholder. Real implementation would:
        // 1. Call multiple search APIs
        // 2. Aggregate and deduplicate results
        // 3. Rank by relevance
        // 4. Cache the results

        throw NSError(domain: "WebSearchService", code: 1, userInfo: [
            NSLocalizedDescriptionKey: "Client-side web search requires MCP integration"
        ])
    }

    init() {
        loadHistory()
    }
}
