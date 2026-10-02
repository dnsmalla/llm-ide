import Foundation
import LlmIdeMacLib

// `RepoGraphLocator.reposToGraph` (Core): every repo a project's code graph
// should cover. The auto-updater graphed only the FIRST `code/` child, so a
// project holding several repos left all but one invisible to code-relations
// and find-code. Core, so these run in every feature profile.

func runRepoGraphLocatorChecks() {
    print("repo graph locator")
    let fm = FileManager.default
    let root = fm.temporaryDirectory.appendingPathComponent("repo-locator-\(UUID().uuidString)")
    defer { try? fm.removeItem(at: root) }
    func dir(_ rel: String) { try? fm.createDirectory(at: root.appendingPathComponent(rel), withIntermediateDirectories: true) }
    func file(_ rel: String) { try? "x".write(to: root.appendingPathComponent(rel), atomically: true, encoding: .utf8) }

    dir("multi/code/web"); dir("multi/code/api"); dir("multi/code/.hidden")
    file("multi/code/NOTES.md")
    let multi = RepoGraphLocator.reposToGraph(projectRoot: root.appendingPathComponent("multi"))
    expect(multi.map(\.lastPathComponent) == ["api", "web"],
           "every code/<repo> child is listed, sorted, without hidden dirs or files")

    dir("flat"); file("flat/main.py")
    expect(RepoGraphLocator.reposToGraph(projectRoot: root.appendingPathComponent("flat")).map(\.lastPathComponent) == ["flat"],
           "a project with no code/ children is its own single repo")

    dir("empty")
    expect(RepoGraphLocator.reposToGraph(projectRoot: root.appendingPathComponent("empty")).isEmpty,
           "an empty project has nothing to graph")
}
