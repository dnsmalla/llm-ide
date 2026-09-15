import SwiftUI

/// Compact platform × capture-path matrix shown under Settings → Connections → Meetings.
struct MeetingCaptureMatrixView: View {
    @EnvironmentObject var theme: ThemeStore

    var body: some View {
        let t = theme.current
        VStack(alignment: .leading, spacing: Spacing.xs) {
            HStack(spacing: Spacing.sm) {
                Text("Platform")
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text("Mac app")
                    .frame(width: 56, alignment: .center)
                Text("Extension")
                    .frame(width: 72, alignment: .center)
            }
            .font(Typography.caption)
            .foregroundStyle(t.textMuted)

            ForEach(MeetingCaptureMatrix.platforms) { platform in
                HStack(spacing: Spacing.sm) {
                    Text(platform.displayName)
                        .font(Typography.caption)
                        .foregroundStyle(t.text)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    matrixMark(platform.nativeMac, tint: t.success)
                        .frame(width: 56)
                    matrixMark(platform.chromeExtension, tint: t.accent2)
                        .frame(width: 72)
                }
            }

            Text(MeetingCaptureMatrix.extensionNote)
                .font(Typography.caption)
                .foregroundStyle(t.textMuted)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 2)
        }
        .padding(.top, Spacing.xs)
    }

    @ViewBuilder
    private func matrixMark(_ supported: Bool, tint: Color) -> some View {
        if supported {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 11))
                .foregroundStyle(tint)
        } else {
            Text("—")
                .font(Typography.caption)
                .foregroundStyle(theme.current.textMuted)
        }
    }
}
