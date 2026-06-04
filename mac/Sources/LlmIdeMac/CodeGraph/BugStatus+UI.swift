// Theme tint for the status dot / pill — same colors everywhere
// the four BugStatus states are rendered (Memory tab, Regression
// sidebar). One source of truth so the two views can't drift.
//
// Lives in a separate file from BugReport.swift so the model stays
// free of a SwiftUI import.

import SwiftUI

extension BugStatus {
    func tint(_ t: Theme) -> Color {
        switch self {
        case .open:         return t.danger
        case .acknowledged: return t.accent2
        case .fixed:        return t.accent3
        case .wontFix:      return t.textMuted
        }
    }
}
