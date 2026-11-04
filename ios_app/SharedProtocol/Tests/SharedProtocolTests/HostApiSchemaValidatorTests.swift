import Testing
import Foundation
import SharedProtocol

@Suite("HostApiSchemaValidator")
struct HostApiSchemaValidatorTests {
    private var defs: [String: Any] { HostApiSchemas.envelope["$defs"] as? [String: Any] ?? [:] }

    @Test("every valid frame fixture matches the envelope")
    func validFrames() throws {
        for name in try HostApiFixtures.names("fixtures/valid") {
            let value = try HostApiFixtures.json("fixtures/valid/\(name)")
            #expect(HostApiSchemaValidator.validate(HostApiSchemas.envelope, value, defs: defs).isEmpty, "\(name)")
        }
    }

    @Test("every invalid frame fixture fails its variant at the expected path and fails the root oneOf")
    func invalidFrames() throws {
        let cases = try #require((try HostApiFixtures.json("fixtures/invalid-cases.json") as? [String: Any])?["envelope"] as? [String: [String: String]])
        #expect(Set(cases.keys) == Set(try HostApiFixtures.names("fixtures/invalid")))
        for (name, c) in cases {
            let value = try HostApiFixtures.json("fixtures/invalid/\(name)")
            let variant = try #require(defs[c["def"]!], "\(name)")
            let failures = HostApiSchemaValidator.validate(variant, value, defs: defs)
            #expect(failures.contains { $0.path == c["at"] }, "\(name): \(failures)")
            #expect(!HostApiSchemaValidator.validate(HostApiSchemas.envelope, value, defs: defs).isEmpty, "\(name)")
        }
    }

    @Test("every command fixture matches its request or result schema")
    func commandFixtures() throws {
        for command in HostApiCommand.allCases {
            let request = try HostApiFixtures.json("fixtures/commands/\(command.rawValue).request.json")
            let result = try HostApiFixtures.json("fixtures/commands/\(command.rawValue).result.json")
            #expect(HostApiSchemaValidator.validate(HostApiSchemas.request(for: command), request, defs: defs).isEmpty, "\(command)")
            #expect(HostApiSchemaValidator.validate(HostApiSchemas.result(for: command), result, defs: defs).isEmpty, "\(command)")
        }
    }

    @Test("every invalid command fixture fails at the expected path")
    func invalidCommandFixtures() throws {
        let cases = try #require((try HostApiFixtures.json("fixtures/invalid-cases.json") as? [String: Any])?["commands"] as? [String: [String: String]])
        #expect(Set(cases.keys) == Set(try HostApiFixtures.names("fixtures/invalid/commands")))
        for (name, c) in cases {
            let command = try #require(HostApiCommand(rawValue: c["command"]!))
            let schema = c["kind"] == "request" ? HostApiSchemas.request(for: command) : HostApiSchemas.result(for: command)
            let failures = HostApiSchemaValidator.validate(schema, try HostApiFixtures.json("fixtures/invalid/commands/\(name)"), defs: defs)
            #expect(failures.contains { $0.path == c["at"] }, "\(name): \(failures)")
        }
    }

    @Test("JSON booleans are not integers, and integers are not booleans")
    func boolIntDistinction() {
        let intSchema: [String: Any] = ["type": "integer"]
        let boolSchema: [String: Any] = ["type": "boolean"]
        let parsed = try! JSONSerialization.jsonObject(with: Data(#"[true, 1, 1.5]"#.utf8)) as! [Any]
        #expect(!HostApiSchemaValidator.validate(intSchema, parsed[0], defs: [:]).isEmpty)
        #expect(HostApiSchemaValidator.validate(intSchema, parsed[1], defs: [:]).isEmpty)
        #expect(!HostApiSchemaValidator.validate(intSchema, parsed[2], defs: [:]).isEmpty)
        #expect(!HostApiSchemaValidator.validate(boolSchema, parsed[1], defs: [:]).isEmpty)
    }

    @Test("lengths count UTF-16 code units, like the Node validator")
    func utf16Lengths() {
        let schema: [String: Any] = ["type": "string", "maxLength": 1]
        #expect(!HostApiSchemaValidator.validate(schema, "😀", defs: [:]).isEmpty, "one emoji is two UTF-16 units")
        #expect(HostApiSchemaValidator.validate(schema, "é", defs: [:]).isEmpty)
    }
}
