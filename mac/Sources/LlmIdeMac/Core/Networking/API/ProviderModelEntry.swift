import Foundation

/// One row of `POST /kb/providers/models` `entries[]`. Public so
/// chat-contract-lab can decode it; `effortLevels` is absent on servers
/// before apiVersion 63 and decodes as [] there.
public struct ProviderModelEntry: Decodable, Equatable {
    public let id: String
    public let displayName: String?
    public let effortLevels: [String]

    private enum CodingKeys: String, CodingKey { case id, displayName, effortLevels }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        displayName = try c.decodeIfPresent(String.self, forKey: .displayName)
        effortLevels = try c.decodeIfPresent([String].self, forKey: .effortLevels) ?? []
    }
}
