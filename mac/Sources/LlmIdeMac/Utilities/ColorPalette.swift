import SwiftUI

enum ColorPalette {
    static let palette: [Color] = [.blue, .purple, .pink, .orange, .green, .teal, .indigo, .red]

    static func color(for id: Int) -> Color {
        palette[abs(id) % palette.count]
    }

    static func color(for string: String) -> Color {
        palette[abs(string.hashValue) % palette.count]
    }
}

extension Color {
    init?(hex: String) {
        let h = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
        guard h.count == 6, let val = UInt64(h, radix: 16) else { return nil }
        self.init(red: Double((val >> 16) & 0xFF) / 255,
                  green: Double((val >> 8) & 0xFF) / 255,
                  blue: Double(val & 0xFF) / 255)
    }
}
