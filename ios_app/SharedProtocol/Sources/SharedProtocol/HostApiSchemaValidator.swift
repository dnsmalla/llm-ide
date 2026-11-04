import Foundation

/// The JSON Schema subset the Host API uses, judged exactly like `extension/routes/bus/schema-validate.mjs`
/// (same keywords, same failure paths), so Swift and Node hosts accept and refuse the same frames.
/// Keywords: type, enum, const, required, properties, additionalProperties (bool | schema), items,
/// minItems, maxItems, minLength, maxLength (UTF-16 units, like JS), pattern, minimum, maximum, oneOf,
/// $ref (`#/$defs/Name`). Values are `JSONSerialization` output.
public enum HostApiSchemaValidator {
    public struct Failure: Equatable, Sendable, CustomStringConvertible {
        public let path: String
        public let message: String
        public var description: String { "\(path): \(message)" }
    }

    public static func validate(_ schema: Any, _ value: Any, defs: [String: Any], path: String = "") -> [Failure] {
        var out: [Failure] = []
        func bad(_ m: String) { out.append(Failure(path: path.isEmpty ? "(root)" : path, message: m)) }
        guard let schema = schema as? [String: Any] else { return out }
        if let ref = schema["$ref"] as? String {
            let name = ref.replacingOccurrences(of: "#/$defs/", with: "")
            guard let target = defs[name] else { bad("unresolved $ref \(ref)"); return out }
            return validate(target, value, defs: defs, path: path)
        }
        if let variants = schema["oneOf"] as? [Any] {
            let hits = variants.filter { validate($0, value, defs: defs, path: path).isEmpty }.count
            if hits != 1 { bad("must match exactly one variant (matched \(hits))") }
            return out
        }
        if let constant = schema["const"], !jsonEqual(value, constant) { bad("must equal \(constant)"); return out }
        if let options = schema["enum"] as? [Any], !options.contains(where: { jsonEqual(value, $0) }) {
            bad("must be one of \(options.map { "\($0)" }.joined(separator: ", "))"); return out
        }
        if let type = schema["type"] {
            let types = (type as? [String]) ?? [(type as? String) ?? ""]
            if !types.contains(where: { isType(value, $0) }) { bad("must be \(types.joined(separator: " or "))"); return out }
        }
        if let s = value as? String, !isNumber(value) {
            let n = s.utf16.count
            if let min = schema["minLength"] as? Int, n < min { bad("shorter than \(min)") }
            if let max = schema["maxLength"] as? Int, n > max { bad("longer than \(max)") }
            if let p = schema["pattern"] as? String, !matches(s, p) { bad("does not match the required pattern") }
        }
        if isNumber(value), let n = (value as? NSNumber)?.doubleValue {
            if let min = (schema["minimum"] as? NSNumber)?.doubleValue, n < min { bad("below \(min)") }
            if let max = (schema["maximum"] as? NSNumber)?.doubleValue, n > max { bad("above \(max)") }
        }
        if let a = value as? [Any] {
            if let min = schema["minItems"] as? Int, a.count < min { bad("fewer than \(min) items") }
            if let max = schema["maxItems"] as? Int, a.count > max { bad("more than \(max) items") }
            if let items = schema["items"] {
                for (i, v) in a.enumerated() { out += validate(items, v, defs: defs, path: "\(path)[\(i)]") }
            }
        }
        if let o = value as? [String: Any] {
            for k in (schema["required"] as? [String]) ?? [] where o[k] == nil {
                out.append(Failure(path: "\(path).\(k)", message: "is required"))
            }
            let props = (schema["properties"] as? [String: Any]) ?? [:]
            for k in o.keys.sorted() {
                let v = o[k]!
                if let p = props[k] { out += validate(p, v, defs: defs, path: "\(path).\(k)") }
                else if (schema["additionalProperties"] as? Bool) == false { out.append(Failure(path: "\(path).\(k)", message: "is not allowed")) }
                else if let ap = schema["additionalProperties"] as? [String: Any] { out += validate(ap, v, defs: defs, path: "\(path).\(k)") }
            }
        }
        return out
    }

    // MARK: - JSON kinds (JSONSerialization hands back NSNumber for both numbers and booleans)

    static func isBool(_ v: Any) -> Bool {
        guard let n = v as? NSNumber else { return false }
        return CFGetTypeID(n) == CFBooleanGetTypeID()
    }

    static func isNumber(_ v: Any) -> Bool { v is NSNumber && !isBool(v) }

    static func isType(_ v: Any, _ t: String) -> Bool {
        switch t {
        case "null": return v is NSNull
        case "boolean": return isBool(v)
        case "integer":
            guard isNumber(v), let d = (v as? NSNumber)?.doubleValue else { return false }
            return d.isFinite && d.rounded() == d
        case "number": return isNumber(v) && ((v as? NSNumber)?.doubleValue.isFinite ?? false)
        case "string": return v is String
        case "array": return v is [Any]
        case "object": return v is [String: Any]
        default: return false
        }
    }

    static func jsonEqual(_ a: Any, _ b: Any) -> Bool {
        if isBool(a) || isBool(b) { return isBool(a) && isBool(b) && (a as! NSNumber).boolValue == (b as! NSNumber).boolValue }
        if isNumber(a), isNumber(b) { return (a as! NSNumber).doubleValue == (b as! NSNumber).doubleValue }
        if let x = a as? String, let y = b as? String { return x == y }
        if a is NSNull, b is NSNull { return true }
        return false
    }

    private static let regexCache = NSCache<NSString, NSRegularExpression>()

    /// JS `RegExp.test`: an unanchored search; Host API patterns anchor themselves with `^…$`.
    static func matches(_ s: String, _ pattern: String) -> Bool {
        let regex: NSRegularExpression
        if let cached = regexCache.object(forKey: pattern as NSString) { regex = cached }
        else {
            guard let built = try? NSRegularExpression(pattern: pattern) else { return false }
            regexCache.setObject(built, forKey: pattern as NSString)
            regex = built
        }
        return regex.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
    }
}
