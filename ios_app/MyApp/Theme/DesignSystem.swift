//
//  DesignSystem.swift
//  Production design system for LLM IDE
//

import SwiftUI
import UIKit

public struct DesignSystem {
    /// Adaptive palette — every token has a light and dark variant so the app
    /// follows the system appearance.
    public struct Colors {
        public static let primary          = Color(light: "#5B5FC7", dark: "#7B7FE8")
        public static let primaryDark      = Color(light: "#4346A8", dark: "#5B5FC7")
        public static let primaryLight     = Color(light: "#E8E9F9", dark: "#272A4A")
        public static let background       = Color(light: "#F5F6FA", dark: "#0F1117")
        public static let surface          = Color(light: "#FFFFFF", dark: "#1A1D27")
        public static let surfaceSecondary = Color(light: "#FAFBFC", dark: "#232734")
        public static let textPrimary      = Color(light: "#1A1D2E", dark: "#F2F3F7")
        public static let textSecondary    = Color(light: "#5C6178", dark: "#A7ACC0")
        public static let textTertiary     = Color(light: "#8E94A8", dark: "#6E7488")
        public static let danger           = Color(light: "#E53935", dark: "#FF6B66")
        public static let success          = Color(light: "#2E7D32", dark: "#5BC75F")
        public static let border           = Color(light: "#E4E6ED", dark: "#2A2E3D")
        public static let borderLight      = Color(light: "#EEF0F5", dark: "#232734")
        public static var primaryGradient: LinearGradient {
            LinearGradient(colors: [primary, primaryDark], startPoint: .topLeading, endPoint: .bottomTrailing)
        }
    }

    public struct Spacing {
        public static let xs: CGFloat = 6
        public static let sm: CGFloat = 12
        public static let md: CGFloat = 16
        public static let lg: CGFloat = 24
        public static let xl: CGFloat = 32
        public static let xxl: CGFloat = 40
    }

    public struct Layout {
        public static let marginMobile: CGFloat = 20
        public static let marginTablet: CGFloat = 24
        public static let cornerRadiusS: CGFloat = 10
        public static let cornerRadiusM: CGFloat = 14
        public static let cornerRadiusL: CGFloat = 20
        public static let cornerRadiusXL: CGFloat = 28
        public static let shadowRadius: CGFloat = 16
        public static let shadowOpacity: Double = 0.06
        public static let shadowRadiusSmall: CGFloat = 8
        public static let shadowOpacitySmall: Double = 0.04
    }

    public struct Typography {
        public static let largeTitle: CGFloat = 34
        public static let title: CGFloat = 28
        public static let title2: CGFloat = 22
        public static let headline: CGFloat = 17
        public static let body: CGFloat = 16
        public static let callout: CGFloat = 15
        public static let subheadline: CGFloat = 14
        public static let footnote: CGFloat = 12
        public static let caption: CGFloat = 12
    }
}

extension Color {
    init(hex: String) {
        let scanner = Scanner(string: hex)
        _ = scanner.scanString("#")
        var rgb: UInt64 = 0
        scanner.scanHexInt64(&rgb)
        let red = Double((rgb >> 16) & 0xFF) / 255.0
        let green = Double((rgb >> 8) & 0xFF) / 255.0
        let blue = Double(rgb & 0xFF) / 255.0
        self.init(red: red, green: green, blue: blue)
    }

    /// Dynamic color that resolves per the system appearance.
    init(light: String, dark: String) {
        self.init(UIColor { trait in
            UIColor(Color(hex: trait.userInterfaceStyle == .dark ? dark : light))
        })
    }
}
