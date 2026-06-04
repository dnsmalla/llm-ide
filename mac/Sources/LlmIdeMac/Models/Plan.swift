import Foundation

/// Mirrors `src/lib/plan.ts` on the React side and the SQL shape in
/// `kb/db.mjs`.  We keep all string-coded enums (status, risk) loose so
/// a backend that gains new values doesn't break the decoder — unknown
/// values fall through to nil.

enum TaskStatus: String, Codable {
    case planned = "planned"
    case inProgress = "in_progress"
    case done = "done"
    case blocked = "blocked"
}

enum RiskLevel: String, Codable {
    case low, med, high
}

struct CodeRef: Codable, Identifiable, Equatable {
    var id: String { ref ?? title }
    let ref: String?
    let title: String
    let bodyExcerpt: String?
    let rank: Double?
}

struct PlanTask: Codable, Identifiable, Equatable {
    let id: String
    let planId: String?
    let position: Int
    let milestone: String?
    let title: String
    let description: String?
    let owner: String?
    let due: String?            // YYYY-MM-DD or nil
    let estimateDays: Double?
    let dependsOn: [String]
    let status: String          // raw — UI maps to TaskStatus when valid
    let risk: String?           // raw — UI maps to RiskLevel when valid
    let riskReason: String?
    let files: [CodeRef]
    let meta: [String: AnyCodable]?

    var resolvedStatus: TaskStatus { TaskStatus(rawValue: status) ?? .planned }
    var resolvedRisk: RiskLevel? { risk.flatMap(RiskLevel.init(rawValue:)) }
}

struct Plan: Codable, Identifiable, Equatable {
    let id: String
    let meetingId: String?
    let title: String
    let goal: String?
    let language: String?
    let createdAt: String?
    let updatedAt: String?
    let tasks: [PlanTask]
}

struct PlanSummary: Codable, Identifiable, Equatable {
    let id: String
    let title: String
    let meetingId: String?
    let createdAt: String
    let updatedAt: String
    let taskCount: Int
}

/// Type-erased Codable JSON value, used for `meta` blobs whose shape
/// varies per task.  Decodes any JSON scalar/array/object; encodes back
/// in the same shape.  Tiny implementation — we don't need full
/// JSONValue sophistication, just round-trippable opaque storage.
struct AnyCodable: Codable, Equatable {
    let value: Any?

    init(_ value: Any?) { self.value = value }

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() {
            self.value = nil
        } else if let s = try? c.decode(String.self) {
            self.value = s
        } else if let i = try? c.decode(Int.self) {
            self.value = i
        } else if let b = try? c.decode(Bool.self) {
            self.value = b
        } else if let d = try? c.decode(Double.self) {
            self.value = d
        } else if let dict = try? c.decode([String: AnyCodable].self) {
            self.value = dict.mapValues { $0.value }
        } else if let arr = try? c.decode([AnyCodable].self) {
            self.value = arr.map { $0.value }
        } else {
            self.value = nil
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch value {
        case nil: try c.encodeNil()
        case let b as Bool: try c.encode(b)
        case let i as Int: try c.encode(i)
        case let d as Double: try c.encode(d)
        case let s as String: try c.encode(s)
        case let arr as [Any?]: try c.encode(arr.map { AnyCodable($0) })
        case let dict as [String: Any?]: try c.encode(dict.mapValues { AnyCodable($0) })
        default: try c.encodeNil()
        }
    }

    static func == (lhs: AnyCodable, rhs: AnyCodable) -> Bool {
        // Equality is best-effort by JSON serialization — sufficient
        // for SwiftUI diffing, which is the only caller.
        let l = (try? AppJSON.encoder.encode(lhs)) ?? Data()
        let r = (try? AppJSON.encoder.encode(rhs)) ?? Data()
        return l == r
    }
}
