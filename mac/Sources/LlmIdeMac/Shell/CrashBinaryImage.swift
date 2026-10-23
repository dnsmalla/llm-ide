import Foundation
import MachO

/// Identity of the Mach-O image our own code is linked into, written into
/// the uncaught-exception crash file (`installCrashHandlers()`).
///
/// Why: release binaries are stripped (the dSYM is kept outside the .app), so
/// `NSException.callStackSymbols` can only name EXPORTED symbols — our own
/// frames come out as bare addresses or as the nearest exported symbol plus a
/// meaningless offset. With the image's LC_UUID (to pick the matching dSYM)
/// and its load address (to undo ASLR), every frame address in the file can be
/// symbolicated after the fact:
///
///     atos -o LlmIdeMac.dSYM/Contents/Resources/DWARF/LlmIdeMac \
///          -arch arm64 -l <load address> <frame address> …
///
/// `#dsohandle` rather than `_dyld_get_image_header(0)`: it is the header of
/// the image containing THIS code, so the answer stays right even if the
/// library were ever linked dynamically instead of into the executable.
enum CrashBinaryImage {
    /// Multi-line description for the crash file. Computed once at handler
    /// install (normal startup context), never inside the handler itself.
    ///
    /// - Post: always non-empty; fields that cannot be read say "unknown".
    static func describe(header: UnsafeRawPointer = #dsohandle) -> String {
        let path = imagePath(header: header) ?? "unknown"
        let uuid = uuid(header: header)?.uuidString ?? "unknown"
        let arch = architecture(header: header)
        let loadAddress = String(format: "0x%llx", UInt64(UInt(bitPattern: header)))
        return """
            binary image: \(path)
            arch: \(arch)
            uuid: \(uuid)
            load address: \(loadAddress)
            symbolicate: atos -o <dSYM with uuid \(uuid)>/Contents/Resources/DWARF/\
            \((path as NSString).lastPathComponent) -arch \(arch) -l \(loadAddress) <frame address>…
            """
    }

    /// The image's LC_UUID — the key that matches a binary to its dSYM
    /// (`dwarfdump --uuid` prints the same value for both).
    ///
    /// - Post: nil when `header` is not a 64-bit Mach-O header or carries no
    ///   LC_UUID load command.
    static func uuid(header: UnsafeRawPointer) -> UUID? {
        let machHeader = header.load(as: mach_header_64.self)
        guard machHeader.magic == UInt32(MH_MAGIC_64) else { return nil }
        var cursor = header + MemoryLayout<mach_header_64>.size
        for _ in 0..<machHeader.ncmds {
            let command = cursor.load(as: load_command.self)
            if command.cmd == UInt32(LC_UUID) {
                return UUID(uuid: cursor.load(as: uuid_command.self).uuid)
            }
            // A zero size would loop on the same command forever.
            guard command.cmdsize > 0 else { return nil }
            cursor += Int(command.cmdsize)
        }
        return nil
    }

    private static func imagePath(header: UnsafeRawPointer) -> String? {
        var info = Dl_info()
        guard dladdr(header, &info) != 0, let name = info.dli_fname else { return nil }
        return String(cString: name)
    }

    /// atos's `-arch` spelling, read from the header (not `#if arch`, so a
    /// Rosetta / universal launch reports the slice that actually ran).
    private static func architecture(header: UnsafeRawPointer) -> String {
        let cpuType = header.load(as: mach_header_64.self).cputype
        if cpuType == CPU_TYPE_ARM64 { return "arm64" }
        if cpuType == CPU_TYPE_X86_64 { return "x86_64" }
        return "unknown"
    }
}
