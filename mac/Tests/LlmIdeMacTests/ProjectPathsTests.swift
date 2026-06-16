import Testing
import Foundation
@testable import LlmIdeMac

struct ProjectPathsTests {

    // MARK: - Image files always route to assets

    @Test func imageRoutesToAssetsForNotes() {
        #expect(ProjectPaths.subfolder(for: .notes, fileName: "diagram.png") == "assets")
    }

    @Test func imageRoutesToAssetsForCode() {
        #expect(ProjectPaths.subfolder(for: .code, fileName: "screenshot.jpg") == "assets")
    }

    @Test func imageRoutesToAssetsForData() {
        #expect(ProjectPaths.subfolder(for: .data, fileName: "chart.svg") == "assets")
    }

    @Test func imageRoutesToAssetsForMeetings() {
        #expect(ProjectPaths.subfolder(for: .meetings, fileName: "slide.heic") == "assets")
    }

    @Test func allImageExtensionsRouteToAssets() {
        let images = ["png", "jpg", "jpeg", "gif", "heic", "heif", "webp", "bmp", "tiff", "svg"]
        for ext in images {
            #expect(
                ProjectPaths.subfolder(for: .notes, fileName: "file.\(ext)") == "assets",
                "Expected 'assets' for extension '\(ext)'"
            )
        }
    }

    // MARK: - Non-image files route by category

    @Test func csvRoutesToData() {
        #expect(ProjectPaths.subfolder(for: .data, fileName: "rows.csv") == "data")
    }

    @Test func markdownRoutesToNotes() {
        #expect(ProjectPaths.subfolder(for: .notes, fileName: "readme.md") == "notes")
    }

    @Test func swiftRoutesToCode() {
        #expect(ProjectPaths.subfolder(for: .code, fileName: "main.swift") == "code")
    }

    @Test func txtRoutesToMeetings() {
        #expect(ProjectPaths.subfolder(for: .meetings, fileName: "transcript.txt") == "meetings")
    }

    @Test func extensionCaseInsensitive() {
        // Upper-case extension should still route correctly.
        #expect(ProjectPaths.subfolder(for: .notes, fileName: "Photo.PNG") == "assets")
        #expect(ProjectPaths.subfolder(for: .data, fileName: "Data.CSV") == "data")
    }

    // MARK: - destinationURL

    @Test func destinationURLJoinsRootSubfolderFileName() {
        let root = URL(fileURLWithPath: "/tmp/proj")
        let url = ProjectPaths.destinationURL(root: root, category: .data, fileName: "rows.csv")
        #expect(url.path == "/tmp/proj/data/rows.csv")
    }

    @Test func destinationURLForImage() {
        let root = URL(fileURLWithPath: "/tmp/proj")
        let url = ProjectPaths.destinationURL(root: root, category: .notes, fileName: "diagram.png")
        #expect(url.path == "/tmp/proj/assets/diagram.png")
    }

    // MARK: - isInside

    @Test func isInsideTrueForDirectChild() {
        let root = URL(fileURLWithPath: "/tmp/proj")
        let file = URL(fileURLWithPath: "/tmp/proj/notes/a.md")
        #expect(ProjectPaths.isInside(file, root: root) == true)
    }

    @Test func isInsideFalseForSiblingPath() {
        let root = URL(fileURLWithPath: "/tmp/proj")
        let file = URL(fileURLWithPath: "/tmp/other/a.md")
        #expect(ProjectPaths.isInside(file, root: root) == false)
    }

    @Test func isInsideFalseForPrefixMatchWithoutBoundary() {
        // "/tmp/proj-extra" should NOT be considered inside "/tmp/proj"
        let root = URL(fileURLWithPath: "/tmp/proj")
        let file = URL(fileURLWithPath: "/tmp/proj-extra/a.md")
        #expect(ProjectPaths.isInside(file, root: root) == false)
    }

    @Test func isInsideTrueForRootItself() {
        let root = URL(fileURLWithPath: "/tmp/proj")
        #expect(ProjectPaths.isInside(root, root: root) == true)
    }
}
