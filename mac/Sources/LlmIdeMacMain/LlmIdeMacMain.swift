import LlmIdeMacLib
import SwiftUI

/// Thin executable entry — keeps `@main` out of the library so XCTest can
/// `@testable import LlmIdeMacLib`.
@main
struct LlmIdeMacMain: App {
    private let app = LlmIdeMacApp()

    var body: some Scene {
        app.body
    }
}
