//
//  DesignSystem.swift
//  Production design system for LLM-IDE
//

import SwiftUI
import UIKit

public struct DesignSystem {
    /// Adaptive palette — every token has a light and dark variant so the app
    /// follows the system appearance.
    public struct Colors {
        public static let primary          = Color(light: "#2E7D8F", dark: "#66B8D1")
        public static let primaryDark      = Color(light: "#21606E", dark: "#4DA0BB")
        public static let primaryLight     = Color(light: "#DDEEF1", dark: "#182E33")
        public static let background       = Color(light: "#F7F7FA", dark: "#12141C")
        public static let surface          = Color(light: "#FFFFFF", dark: "#242633")
        public static let surfaceSecondary = Color(light: "#F2F4FA", dark: "#303342")
        public static let textPrimary      = Color(light: "#1F242E", dark: "#F0F2FA")
        public static let textSecondary    = Color(light: "#6B758C", dark: "#C7CFE6")
        public static let textTertiary     = Color(light: "#8B91A3", dark: "#838AA0")
        public static let danger           = Color(light: "#CC3333", dark: "#F58080")
        public static let success          = Color(light: "#2EA666", dark: "#61E6A6")
        public static let border           = Color(light: "#D8DAE3", dark: "#33353C")
        public static let borderLight      = Color(light: "#ECEEF4", dark: "#262B3A")
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
