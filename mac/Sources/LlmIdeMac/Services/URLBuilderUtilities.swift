import Foundation

/// Centralized URL and path building. Single source of truth for:
/// - Safe path component handling (prevent injection)
/// - Query parameter encoding
/// - URL construction patterns
/// - Path sanitization
///
/// Replaces 91+ scattered URL.appendingPathComponent and URLComponents calls across 41 files.
struct URLBuilderUtilities {
    enum URLError: LocalizedError {
        case invalidPath
        case invalidURL
        case invalidQueryParameter

        var errorDescription: String? {
            switch self {
            case .invalidPath:
                return "Invalid path component"
            case .invalidURL:
                return "Invalid URL"
            case .invalidQueryParameter:
                return "Invalid query parameter"
            }
        }
    }

    // MARK: - Path Building

    static func appendingPathComponent(_ component: String, to url: URL) throws -> URL {
        try validatePathComponent(component)
        return url.appendingPathComponent(component, isDirectory: false)
    }

    static func appendingDirectoryComponent(_ component: String, to url: URL) throws -> URL {
        try validatePathComponent(component)
        return url.appendingPathComponent(component, isDirectory: true)
    }

    private static func validatePathComponent(_ component: String) throws {
        guard !component.contains(".."), !component.starts(with: "/"), !component.contains("\0") else {
            throw URLError.invalidPath
        }
    }

    /// Build a path from multiple components safely.
    static func buildPath(components: [String], startingFrom baseURL: URL) throws -> URL {
        var url = baseURL
        for component in components {
            url = try appendingPathComponent(component, to: url)
        }
        return url
    }

    // MARK: - Query Parameter Building

    /// Build URL with query parameters, safely encoding values.
    static func buildURLWithQueryParams(
        baseURL: URL,
        parameters: [String: String]
    ) throws -> URL {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)
        components?.queryItems = parameters.map { key, value in
            URLQueryItem(name: key, value: value)
        }

        guard let url = components?.url else {
            throw URLError.invalidURL
        }

        return url
    }

    /// Add a query parameter to an existing URL.
    static func addingQueryParameter(
        name: String,
        value: String,
        to url: URL
    ) throws -> URL {
        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        var queryItems = components?.queryItems ?? []
        queryItems.append(URLQueryItem(name: name, value: value))
        components?.queryItems = queryItems

        guard let newURL = components?.url else {
            throw URLError.invalidURL
        }

        return newURL
    }

    // MARK: - Common Patterns

    /// Build a REST API endpoint URL: baseURL/resource/id
    static func buildRESTEndpoint(
        baseURL: URL,
        resource: String,
        id: String? = nil,
        subresource: String? = nil
    ) throws -> URL {
        var url = try appendingDirectoryComponent(resource, to: baseURL)

        if let id = id {
            url = try appendingPathComponent(id, to: url)
        }

        if let subresource = subresource {
            url = try appendingDirectoryComponent(subresource, to: url)
        }

        return url
    }

    /// Build a paginated API URL with page and limit parameters.
    static func buildPaginatedURL(
        baseURL: URL,
        page: Int,
        pageSize: Int
    ) throws -> URL {
        return try buildURLWithQueryParams(
            baseURL: baseURL,
            parameters: [
                "page": String(page),
                "per_page": String(pageSize)
            ]
        )
    }

    /// Build a search URL with query and filters.
    static func buildSearchURL(
        baseURL: URL,
        query: String,
        filters: [String: String]? = nil
    ) throws -> URL {
        var params = ["q": query]
        if let filters = filters {
            params.merge(filters) { _, new in new }
        }
        return try buildURLWithQueryParams(baseURL: baseURL, parameters: params)
    }

    // MARK: - URL Validation

    /// Validate URL is absolute and has expected scheme.
    static func validateURL(_ url: URL, scheme: String? = nil) throws {
        guard url.isFileURL || url.scheme != nil else {
            throw URLError.invalidURL
        }

        if let expectedScheme = scheme {
            guard url.scheme == expectedScheme else {
                throw URLError.invalidURL
            }
        }
    }

    /// Check if URL is a valid HTTP(S) URL.
    static func isHTTPURL(_ url: URL) -> Bool {
        let schemes = ["http", "https"]
        return schemes.contains(url.scheme ?? "")
    }

    // MARK: - Path Utilities

    /// Get file extension safely.
    static func fileExtension(of url: URL) -> String {
        url.pathExtension.lowercased()
    }

    /// Remove file extension from URL.
    static func removingFileExtension(from url: URL) -> URL {
        let pathWithoutExt = url.deletingPathExtension().path
        return URL(fileURLWithPath: pathWithoutExt)
    }

    /// Replace file extension.
    static func replacingFileExtension(_ newExtension: String, in url: URL) -> URL {
        let withoutExt = url.deletingPathExtension()
        return withoutExt.appendingPathExtension(newExtension)
    }

    // MARK: - URL Escaping

    /// Percent-encode a string for use in URL paths.
    static func percentEncodedPathComponent(_ string: String) -> String {
        return string.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? string
    }

    /// Percent-encode a string for use in query parameters.
    static func percentEncodedQueryParameter(_ string: String) -> String {
        return string.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? string
    }
}
