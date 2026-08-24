import SwiftUI

/// Warning shown when the local backend answers `/health` but its API version
/// is below what this Mac build requires. Used on Login, Reconnect, and in
/// Settings → Backend so the mismatch is visible before the user signs in.
struct BackendVersionMismatchBanner: View {
    @EnvironmentObject var theme: ThemeStore
    let message: String

    var body: some View {
        HStack(alignment: .top, spacing: Spacing.xs) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 11))
                .foregroundStyle(theme.current.warning)
            Text(message)
                .font(Typography.caption)
                .foregroundStyle(theme.current.warning)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(Spacing.sm)
        .background(theme.current.warning.opacity(theme.current.isDark ? 0.14 : 0.10))
        .clipShape(RoundedRectangle(cornerRadius: Radius.sm))
    }
}
