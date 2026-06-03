import SwiftUI

/// Small colored chip shared across Plan/Review/History views to show
/// kind tags (action, decision, blocker, code, etc.) and risk levels.
struct KindChip: View {
    @EnvironmentObject var theme: ThemeStore
    let label: String
    let palette: Palette

    enum Palette {
        case neutral, info, success, warning, danger, brand, muted
    }

    var body: some View {
        Text(label)
            .font(.system(size: 10, weight: .semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(background.opacity(theme.current.isDark ? 0.25 : 0.18))
            .foregroundStyle(foreground)
            .cornerRadius(999)
    }

    private var background: Color {
        switch palette {
        case .neutral:  return theme.current.textMuted
        case .info:     return theme.current.accent2
        case .success:  return theme.current.accent3
        case .warning:  return theme.current.accent4
        case .danger:   return theme.current.danger
        case .brand:    return theme.current.accent
        case .muted:    return theme.current.surface2
        }
    }

    private var foreground: Color {
        switch palette {
        case .neutral, .muted:  return theme.current.textMuted
        case .info:             return theme.current.accent2
        case .success:          return theme.current.accent3
        case .warning:          return theme.current.accent4
        case .danger:           return theme.current.danger
        case .brand:            return theme.current.accent
        }
    }
}

extension KindChip {
    /// Convenience constructors for common labels so callers don't
    /// re-spell the palette mapping.
    static func kind(_ kind: String) -> KindChip {
        switch kind {
        case "action":   return KindChip(label: kind, palette: .success)
        case "decision": return KindChip(label: kind, palette: .info)
        case "blocker":  return KindChip(label: kind, palette: .danger)
        case "code":     return KindChip(label: kind, palette: .warning)
        case "ticket":   return KindChip(label: kind, palette: .info)
        case "qa":       return KindChip(label: kind, palette: .danger)
        case "plan":     return KindChip(label: kind, palette: .brand)
        case "task":     return KindChip(label: kind, palette: .success)
        case "outcome":  return KindChip(label: kind, palette: .info)
        case "meeting":  return KindChip(label: kind, palette: .neutral)
        default:         return KindChip(label: kind, palette: .muted)
        }
    }

    static func risk(_ risk: String?) -> KindChip {
        switch risk {
        case "high": return KindChip(label: "high",   palette: .danger)
        case "med":  return KindChip(label: "medium", palette: .warning)
        case "low":  return KindChip(label: "low",    palette: .success)
        default:     return KindChip(label: "—",      palette: .muted)
        }
    }

    static func status(_ status: String) -> KindChip {
        switch status {
        case "approved", "executed":  return KindChip(label: status, palette: .success)
        case "pending":               return KindChip(label: status, palette: .warning)
        case "rejected", "expired":   return KindChip(label: status, palette: .muted)
        case "failed":                return KindChip(label: status, palette: .danger)
        default:                      return KindChip(label: status, palette: .neutral)
        }
    }
}
