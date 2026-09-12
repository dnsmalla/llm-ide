import Foundation
import LlmIdeMacLib

// An executable assertion gate for the generation slice (Doc Gen / Visual).
//
// Same reason as chat-contract-lab, graph-layout-lab and graph-engine-lab: a
// Command-Line-Tools-only toolchain has no XCTest, so `swift test` cannot run
// (see the Makefile's HAS_XCTEST guard), while `swift run` works regardless.
//
// What is worth asserting here is the template SURFACE marker. It decides
// which menu a user's template appears in, it round-trips through a file on
// their disk, and getting it wrong is silent: the template simply shows up in
// the other menu, or in neither.
//
// This is a SEPARATE target, so it sees only `public` symbols of
// LlmIdeMacLib — hence `TemplateSurface`/`TemplateSurfaceMarker` being public.
//
// Scope note: the assertions stop at the marker. Reaching `DocTemplate` /
// `DocCommand` from here would mean making those models (and their custom
// Codable witnesses, and `IngestTemplateKind`) public purely so a lab could
// read static seed data — widening the module's API for no production caller.
// The marker is where the risk actually is: it is parsed from, and written
// back to, a file on the user's disk, and every failure mode is silent.

var failures: [String] = []

func expect(_ condition: Bool, _ label: String) {
    if condition {
        print("  ok   \(label)")
    } else {
        failures.append(label)
        print("  FAIL \(label)")
    }
}

let templateMarker = "<!-- llmide:doc-template -->"
let commandMarker = "<!-- llmide:doc-command -->"

// Writing the marker.
do {
    expect(TemplateSurfaceMarker.line(base: templateMarker, surface: .doc) == templateMarker,
           "a Doc Gen template writes the BARE marker — byte-identical to what earlier versions wrote")
    expect(TemplateSurfaceMarker.line(base: templateMarker, surface: .visual)
               == "<!-- llmide:doc-template surface=visual -->",
           "a Visual template writes the surface into its marker")
    expect(TemplateSurfaceMarker.line(base: commandMarker, surface: .visual)
               == "<!-- llmide:doc-command surface=visual -->",
           "commands use the same attribute on their own marker")
}

// Reading it back.
do {
    let bare = "# T\n\n\(templateMarker)\n\n## A\n"
    expect(TemplateSurfaceMarker.surface(in: bare, base: templateMarker) == .doc,
           "no surface attribute means Doc Gen — every template written before this existed")
    let visual = "# T\n\n<!-- llmide:doc-template surface=visual -->\n\n## A\n"
    expect(TemplateSurfaceMarker.surface(in: visual, base: templateMarker) == .visual,
           "an attributed marker reads back as its surface")
    expect(TemplateSurfaceMarker.surface(in: "# T\n\n## A\n", base: templateMarker) == .doc,
           "a file with no marker at all is Doc Gen, not nothing")
    // A hand-edited file picks up spacing; it must still be read.
    let spaced = "# T\n\n<!--   llmide:doc-template   surface=visual   -->\n"
    expect(TemplateSurfaceMarker.surface(in: spaced, base: templateMarker) == .visual,
           "extra spacing in a hand-edited marker still reads")
    // A typo must not hide the template from every menu.
    let typo = "# T\n\n<!-- llmide:doc-template surface=vsual -->\n"
    expect(TemplateSurfaceMarker.surface(in: typo, base: templateMarker) == .doc,
           "an unrecognised surface falls back to Doc Gen rather than losing the file")
    // The command marker must not be read as a template marker.
    let cmd = "# C\n\n<!-- llmide:doc-command surface=visual -->\n"
    expect(TemplateSurfaceMarker.surface(in: cmd, base: templateMarker) == .doc,
           "a command's marker is not a template's")
}

// `ensure` — the import path, where the file's own bytes are what gets stored.
do {
    let imported = "# Imported\n\nSome body text.\n"
    let stamped = TemplateSurfaceMarker.ensure(in: imported, base: templateMarker, surface: .visual)
    expect(TemplateSurfaceMarker.surface(in: stamped, base: templateMarker) == .visual,
           "an imported file is stamped, so it stays in the menu it was imported into")
    expect(stamped.contains("# Imported") && stamped.contains("Some body text."),
           "and its own content is untouched")

    // Re-stamping replaces rather than accumulating markers.
    let restamped = TemplateSurfaceMarker.ensure(in: stamped, base: templateMarker, surface: .doc)
    expect(TemplateSurfaceMarker.surface(in: restamped, base: templateMarker) == .doc,
           "re-stamping moves the file to the other menu")
    let markerCount = restamped.components(separatedBy: .newlines)
        .filter { $0.contains("llmide:doc-template") }.count
    expect(markerCount == 1, "re-stamping replaces the marker, it does not add a second")

    // A file with no title at all still gets one.
    let untitled = TemplateSurfaceMarker.ensure(in: "just text\n", base: templateMarker, surface: .visual)
    expect(TemplateSurfaceMarker.surface(in: untitled, base: templateMarker) == .visual,
           "a file with no `# Title` still gets its marker")
}

if failures.isEmpty {
    print("generation-contract-lab: all assertions passed")
} else {
    print("generation-contract-lab: \(failures.count) FAILED")
    exit(1)
}
