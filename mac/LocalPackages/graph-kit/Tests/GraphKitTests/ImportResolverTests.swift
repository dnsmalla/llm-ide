import XCTest
import GraphKit

final class ImportResolverTests: XCTestCase {
    private let files: Set<String> = [
        "src/foo.ts", "src/bar.tsx", "src/utils/index.ts",
        "utils.py", "models/user.py", "models/__init__.py"
    ]

    func testRelativeTSImportResolved() {
        let imp = RawImport(module: "./bar")
        let result = ImportResolver.resolve(imp, fromFile: "src/foo.ts",
                                            language: "typescript", files: files)
        XCTAssertEqual(result, "src/bar.tsx")
    }

    func testRelativeTSIndexImportResolved() {
        let imp = RawImport(module: "./utils")
        let result = ImportResolver.resolve(imp, fromFile: "src/foo.ts",
                                            language: "typescript", files: files)
        XCTAssertEqual(result, "src/utils/index.ts")
    }

    func testBarePackageReturnsNil() {
        let imp = RawImport(module: "react")
        let result = ImportResolver.resolve(imp, fromFile: "src/foo.ts",
                                            language: "typescript", files: files)
        XCTAssertNil(result)
    }

    func testPythonModuleResolved() {
        let imp = RawImport(module: "models.user")
        let result = ImportResolver.resolve(imp, fromFile: "main.py",
                                            language: "python", files: files)
        XCTAssertEqual(result, "models/user.py")
    }

    func testPythonFromImportResolved() {
        let imp = RawImport(module: "models", name: "user")
        let result = ImportResolver.resolve(imp, fromFile: "main.py",
                                            language: "python", files: files)
        XCTAssertEqual(result, "models/user.py")
    }

    // MARK: - Python source-root-relative imports

    /// Real projects put their package under a source root on `sys.path`
    /// (e.g. `app/backend/`) rather than at the repo root, so imports are
    /// relative to that root, not the repo. These must still resolve.
    private let pyRooted: Set<String> = [
        "app/backend/controller/user_controller.py",
        "app/backend/controller/base_controller.py",
        "app/backend/schema/user_schema.py",
        "app/backend/service/__init__.py",
    ]

    func testPythonSourceRootRelativeImportResolved() {
        // `from schema.user_schema import X` inside app/backend/controller/...
        let imp = RawImport(module: "schema.user_schema")
        let result = ImportResolver.resolve(
            imp, fromFile: "app/backend/controller/user_controller.py",
            language: "python", files: pyRooted)
        XCTAssertEqual(result, "app/backend/schema/user_schema.py")
    }

    func testPythonSiblingImportResolved() {
        // `import base_controller` (sibling of the importing file)
        let imp = RawImport(module: "base_controller")
        let result = ImportResolver.resolve(
            imp, fromFile: "app/backend/controller/user_controller.py",
            language: "python", files: pyRooted)
        XCTAssertEqual(result, "app/backend/controller/base_controller.py")
    }

    func testPythonPackageImportResolvesToInit() {
        // `import service` → service/__init__.py under the source root
        let imp = RawImport(module: "service")
        let result = ImportResolver.resolve(
            imp, fromFile: "app/backend/controller/user_controller.py",
            language: "python", files: pyRooted)
        XCTAssertEqual(result, "app/backend/service/__init__.py")
    }

    func testPythonThirdPartyImportReturnsNil() {
        let imp = RawImport(module: "fastapi")
        let result = ImportResolver.resolve(
            imp, fromFile: "app/backend/controller/user_controller.py",
            language: "python", files: pyRooted)
        XCTAssertNil(result)
    }

    func testSwiftImportReturnsNil() {
        let imp = RawImport(module: "Foundation")
        let result = ImportResolver.resolve(imp, fromFile: "App.swift",
                                            language: "swift", files: files)
        XCTAssertNil(result)
    }

    func testNormalizeDotDot() {
        XCTAssertEqual(ImportResolver.normalize(joining: "src/utils", "../bar"), "src/bar")
    }

    func testNormalizeDot() {
        XCTAssertEqual(ImportResolver.normalize(joining: "src", "./foo"), "src/foo")
    }

    func testAliasImportResolved() {
        let aliases = ["@/": "src/"]
        let imp = RawImport(module: "@/lib/api")
        let result = ImportResolver.resolve(imp, fromFile: "src/components/Card.tsx",
                                            language: "typescript",
                                            files: ["src/lib/api.ts"],
                                            aliases: aliases)
        XCTAssertEqual(result, "src/lib/api.ts")
    }

    func testAliasWithNoMatchStillReturnsNil() {
        let aliases = ["@/": "src/"]
        let imp = RawImport(module: "@/missing/thing")
        let result = ImportResolver.resolve(imp, fromFile: "src/app.ts",
                                            language: "typescript",
                                            files: ["src/other.ts"],
                                            aliases: aliases)
        XCTAssertNil(result)
    }
}
