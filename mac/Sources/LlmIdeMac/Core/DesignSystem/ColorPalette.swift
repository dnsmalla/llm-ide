import SwiftUI

enum ColorPalette {
    static let palette: [Color] = [.blue, .purple, .pink, .orange, .green, .teal, .indigo, .red]

    static func color(for id: Int) -> Color {
        palette[index(id, count: palette.count)]
    }

    static func color(for string: String) -> Color {
        palette[index(string.hashValue, count: palette.count)]
    }

    /// `value` mapped into `0..<count`. Not `abs(value) % count`: `abs(Int.min)`
    /// overflows and traps, and ids here come from the server.
    static func index(_ value: Int, count: Int) -> Int {
        Int(UInt(bitPattern: value) % UInt(count))
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
