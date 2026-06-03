import Foundation

/// Shared JSONEncoder/JSONDecoder instances.
///
/// Creating a new coder per call is cheap but not free; reusing a single
/// configured instance avoids redundant allocations and centralises any
/// future tweaks (key strategy, output formatting, etc.). Use the bare
/// `encoder` / `decoder` for default behaviour, or the `iso8601Encoder`
/// / `iso8601Decoder` when you need ISO-8601 date encoding.
enum AppJSON {

    /// Default-configured encoder. Safe to share across threads
    /// because `JSONEncoder` is thread-safe in Foundation.
    static let encoder = JSONEncoder()

    /// Default-configured decoder. Safe to share across threads.
    static let decoder = JSONDecoder()

    /// Encoder with `.iso8601` `dateEncodingStrategy`.
    static let iso8601Encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        return e
    }()

    /// Decoder with `.iso8601` `dateDecodingStrategy`.
    static let iso8601Decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }()
}
