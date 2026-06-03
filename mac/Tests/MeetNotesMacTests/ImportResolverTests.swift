import Testing
@testable import MeetNotesMac

struct ImportResolverTests {
    private let files: Set<String> = [
        "pkg/a.py", "pkg/b.py", "pkg/sub/__init__.py",
        "src/foo.ts", "src/bar/baz.ts", "src/bar/index.ts"
    ]

    @Test func resolvesPythonDottedModuleToFile() {
        // from pkg.b import x  -> pkg/b.py
        let r = ImportResolver.resolve(RawImport(module: "pkg.b", name: "x"),
                                       fromFile: "pkg/a.py", language: "python", files: files)
        #expect(r == "pkg/b.py")
    }

    @Test func resolvesPythonPackageInit() {
        let r = ImportResolver.resolve(RawImport(module: "pkg.sub", name: nil),
                                       fromFile: "pkg/a.py", language: "python", files: files)
        #expect(r == "pkg/sub/__init__.py")
    }

    @Test func dropsExternalPythonModule() {
        let r = ImportResolver.resolve(RawImport(module: "os", name: nil),
                                       fromFile: "pkg/a.py", language: "python", files: files)
        #expect(r == nil)
    }

    @Test func resolvesTSRelativeWithExtension() {
        // import from './bar/baz' inside src/foo.ts -> src/bar/baz.ts
        let r = ImportResolver.resolve(RawImport(module: "./bar/baz", name: nil),
                                       fromFile: "src/foo.ts", language: "typescript", files: files)
        #expect(r == "src/bar/baz.ts")
    }

    @Test func resolvesTSRelativeToIndex() {
        // import from './bar' -> src/bar/index.ts
        let r = ImportResolver.resolve(RawImport(module: "./bar", name: nil),
                                       fromFile: "src/foo.ts", language: "typescript", files: files)
        #expect(r == "src/bar/index.ts")
    }

    @Test func dropsBareExternalTSPackage() {
        let r = ImportResolver.resolve(RawImport(module: "react", name: nil),
                                       fromFile: "src/foo.ts", language: "typescript", files: files)
        #expect(r == nil)
    }
}
