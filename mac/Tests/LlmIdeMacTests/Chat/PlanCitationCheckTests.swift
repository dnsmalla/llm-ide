import Testing
import Foundation
@testable import LlmIdeMacLib

/// `PlanCitationCheck` lists the paths a saved plan cites that are not on
/// disk. A plan is only as good as the files it names: the knip plan that
/// motivated this cited `package.json` lines and a report that had already
/// gone stale, and nothing checked either before Execute.
@Suite("Plan citation check")
struct PlanCitationCheckTests {
    /// A fake filesystem: only these absolute paths exist.
    static func exists(_ present: Set<String>) -> (String) -> Bool { { present.contains($0) } }

    @Test("a cited path that is not on disk is reported; one that is, is not")
    func reportsMissing() {
        let plan = """
        ### Task 1: Update the config

        **Files:**
        - Modify: `apps/web/package.json:47-51`
        - Modify: `apps/web/next.config.js`
        """
        let missing = PlanCitationCheck.missingPaths(
            in: plan, root: "/repo", fileExists: Self.exists(["/repo/apps/web/package.json"]))
        #expect(missing == ["apps/web/next.config.js"])
    }

    @Test("files the plan creates are expected to be missing — including later Modify of them")
    func createdFilesAreNotMissing() {
        let plan = """
        - Create: `src/feature/new.ts`
        - Test: `tests/feature/new.test.ts`
        - Modify: `src/feature/new.ts:10-20`
        """
        #expect(PlanCitationCheck.missingPaths(in: plan, root: "/repo", fileExists: Self.exists([])).isEmpty)
    }

    @Test("code fences, commands, URLs, globs, placeholders and bare names are not path claims")
    func ignoresNonPaths() {
        let plan = """
        Run `npm run web:build`, see `https://example.com/a/b`, match `src/**/*.ts`,
        fill in `path/to/<file>.ts`, use `knip@^5`, read `README.md`, skip `node_modules/knip`,
        scratch `/tmp/knip-baseline.txt`.

        ```bash
        cat apps/missing/in-a-fence.txt
        ```

        Inline fenced mention `apps/missing/also.txt` is still checked.
        """
        #expect(PlanCitationCheck.missingPaths(in: plan, root: "/repo", fileExists: Self.exists([]))
                == ["apps/missing/also.txt"])
    }

    // Seen for real: the chat's root was ~/Desktop/LLM while the plan cited
    // paths relative to code/affiliate inside it, which it named in a
    // `cd` line. Resolving only against the root would flag every path.
    @Test("relative paths also resolve against an absolute folder the plan names")
    func resolvesAgainstNamedFolders() {
        let plan = """
        ```bash
        cd /home/u/LLM/code/affiliate
        ```

        - Modify: `apps/shared/package.json`
        - Modify: `apps/gone/index.ts`
        """
        let missing = PlanCitationCheck.missingPaths(
            in: plan, root: "/home/u/LLM",
            fileExists: Self.exists(["/home/u/LLM/code/affiliate/apps/shared/package.json"]))
        #expect(missing == ["apps/gone/index.ts"])
    }

    @Test("absolute and ~ paths are checked as written; duplicates reported once, in order")
    func absoluteAndDedup() {
        let plan = "`/repo/a/x.swift`, `~/proj/b/y.swift`, and again `/repo/a/x.swift`."
        let missing = PlanCitationCheck.missingPaths(
            in: plan, root: "/repo", home: "/home/u", fileExists: Self.exists([]))
        #expect(missing == ["/repo/a/x.swift", "~/proj/b/y.swift"])
    }

    // Both seen on the real knip plan, the only two false alarms it raised.
    @Test("a path the plan says is gone is not a claim that it exists")
    func pathsDeclaredMissing() {
        let plan = """
        The old report lists `apps/shared/validation/` and `apps/_archive/` — none of which still exist.
        `apps/old/index.ts` was deleted last month. `apps/real/missing.ts` is used by the build.
        """
        #expect(PlanCitationCheck.missingPaths(in: plan, root: "/repo", fileExists: Self.exists([]))
                == ["apps/real/missing.ts"])
    }

    @Test("a package-relative path is fine when the plan also cites it in full")
    func packageRelativeTail() {
        let plan = """
        | `apps/shared/types/api.ts` | read by `scripts/check-type-parity.js:23` |
        - `apps/shared` declares `types/api.ts` as an entry.
        """
        let missing = PlanCitationCheck.missingPaths(in: plan, root: "/repo", fileExists: Self.exists([
            "/repo/apps/shared", "/repo/apps/shared/types/api.ts", "/repo/scripts/check-type-parity.js",
        ]))
        #expect(missing.isEmpty)
    }

    @Test("a directory path with a trailing slash counts when the directory exists")
    func directories() {
        #expect(PlanCitationCheck.missingPaths(
            in: "Delete everything under `apps/legacy/`.", root: "/repo",
            fileExists: Self.exists(["/repo/apps/legacy"])).isEmpty)
    }
}

@Suite("Plan citation check — card and payload")
struct PlanCitationCardTests {
    @Test("the card message names up to five paths and counts the rest")
    func message() {
        #expect(PlanSavedCard.missingPathsMessage(["a/b.ts"]).hasPrefix(
            "1 path this plan cites wasn't found in the project when it was saved: `a/b.ts`."))
        let many = (1...7).map { "d/\($0).ts" }
        let msg = PlanSavedCard.missingPathsMessage(many)
        #expect(msg.contains("`d/5.ts` and 2 more."))
        #expect(!msg.contains("d/6.ts"))
    }

    @Test("the missing-path list round-trips, and older payloads without it still decode")
    func payloadCodable() throws {
        let p = ChatMessage.ToolResultPayload(
            kind: .plan, summary: "(saved plan to x.md)", exitCode: nil, command: nil, output: nil,
            url: "/r/x.md", planTitle: "T", planContent: "c", planMissingPaths: ["a/b.ts"])
        let back = try JSONDecoder().decode(ChatMessage.ToolResultPayload.self, from: JSONEncoder().encode(p))
        #expect(back.planMissingPaths == ["a/b.ts"])
        let old = #"{"kind":"plan","summary":"(saved plan to x.md)","planTitle":"T"}"#
        let decoded = try JSONDecoder().decode(ChatMessage.ToolResultPayload.self, from: Data(old.utf8))
        #expect(decoded.planMissingPaths == nil)
    }

    @Test("an all-clear plan stores no field at all")
    func nilWhenClean() {
        #expect(CodeAssistantPanel.missingPlanPaths(in: "No paths here.", root: "/r") == nil)
    }
}
