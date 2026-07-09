#!/usr/bin/env swift

import Foundation

/// Diagnostic script to check for circular references in .llm-ide directory structure
/// Usage: swift scripts/diagnose-circular-ref.swift <repo-root>

func checkCircularReference(in directory: URL, depth: Int = 0, maxDepth: Int = 10, visited: inout Set<String>) -> Bool {
    let path = directory.path

    // Prevent infinite loops
    if depth > maxDepth {
        print("⚠️  Maximum depth reached at: \(path)")
        return false
    }

    // Check if we've already visited this directory
    if visited.contains(path) {
        print("🔄 CIRCULAR REFERENCE DETECTED: \(path)")
        print("   Already visited at depth \(depth)")
        return true
    }

    visited.insert(path)
    let indent = String(repeating: "  ", count: depth)
    print("\(indent)📁 \(directory.lastPathComponent) (\(path))")

    guard let enumerator = FileManager.default.enumerator(at: directory, includingPropertiesForKeys: [.isDirectoryKey]) else {
        return false
    }

    var foundCircular = false
    for case let file as URL in enumerator {
        guard let resourceValues = try? file.resourceValues(forKeys: [.isDirectoryKey]),
              let isDirectory = resourceValues.isDirectory else {
            continue
        }

        if isDirectory {
            let subDir = file
            if checkCircularReference(in: subDir, depth: depth + 1, maxDepth: maxDepth, visited: &visited) {
                foundCircular = true
                // Don't stop checking - find all circular references
            }
        } else {
            print("\(indent)  📄 \(file.lastPathComponent)")
        }
    }

    // Remove from visited set when backtracking (for DAG detection)
    visited.remove(path)

    return foundCircular
}

func checkLLMIdeStructure(at repoRoot: URL) {
    print("🔍 Checking .llm-ide directory structure at: \(repoRoot.path)")
    print("=" * 80)

    let llmIdeDir = repoRoot.appendingPathComponent(".llm-ide")

    guard FileManager.default.fileExists(atPath: llmIdeDir.path) else {
        print("❌ .llm-ide directory does not exist at: \(llmIdeDir.path)")
        return
    }

    print("✅ Found .llm-ide directory")
    print()

    // Check each subdirectory
    let subdirs = ["memory", "graph", "cache"]
    var visited = Set<String>()
    var foundCircular = false

    for subdir in subdirs {
        let dir = llmIdeDir.appendingPathComponent(subdir)
        guard FileManager.default.fileExists(atPath: dir.path) else {
            print("⚠️  \(subdir)/ directory does not exist")
            continue
        }

        print("🔍 Checking \(subdir)/")
        if checkCircularReference(in: dir, depth: 1, visited: &visited) {
            foundCircular = true
        }
        print()
    }

    if foundCircular {
        print("🚨 CIRCULAR REFERENCES FOUND")
    } else {
        print("✅ No circular references detected")
    }
}

// Main
let arguments = CommandLine.arguments
guard arguments.count > 1 else {
    print("Usage: swift diagnose-circular-ref.swift <repo-root>")
    print("Example: swift diagnose-circular-ref.swift /Users/dinsmallade/llm-ide")
    exit(1)
}

let repoRoot = URL(fileURLWithPath: arguments[1])
checkLLMIdeStructure(at: repoRoot)
