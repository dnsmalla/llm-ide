import Foundation

/// Shared JSONEncoder/JSONDecoder instances. Reusing configured instances
/// avoids redundant allocations and centralises any future tweaks.
enum AppJSON {
    static let encoder = JSONEncoder()
    static let decoder = JSONDecoder()

    static let iso8601Encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        return e
    }()

    static let iso8601Decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }()
}
