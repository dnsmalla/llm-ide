import Foundation
import Testing
@testable import LlmIdeMacLib

/// The crash file's binary-image block: without the UUID and load address a
/// stripped release build's exception stack cannot be symbolicated.
@Suite("Crash file binary image")
struct CrashBinaryImageTests {
    @Test("This image's LC_UUID is readable")
    func readsUUID() {
        #expect(CrashBinaryImage.uuid(header: #dsohandle) != nil)
    }

    @Test("The description names the uuid, load address and an atos line")
    func describes() {
        let text = CrashBinaryImage.describe(header: #dsohandle)
        let uuid = CrashBinaryImage.uuid(header: #dsohandle)?.uuidString ?? "missing"
        #expect(text.contains("uuid: \(uuid)"))
        #expect(text.contains(String(format: "load address: 0x%llx",
                                     UInt64(UInt(bitPattern: #dsohandle)))))
        #expect(text.contains("atos -o"))
    }

    @Test("A non-Mach-O buffer yields no UUID instead of a garbage read")
    func rejectsNonMachO() {
        let bytes = [UInt8](repeating: 0, count: 64)
        bytes.withUnsafeBytes { buffer in
            #expect(CrashBinaryImage.uuid(header: buffer.baseAddress!) == nil)
        }
    }
}
