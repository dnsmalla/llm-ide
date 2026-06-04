import SwiftUI
import AppKit

/// Process-wide URLCache shared by every UserAvatar instance.  Without this,
/// Gantt rows + the Issue board re-fetch the same gravatar/GitLab avatar URL
/// every render, hammering the network and producing visible flicker.
/// 5 MB memory + 50 MB on-disk is plenty — avatars are 1–10 KB each.
private let avatarURLCache: URLCache = {
    let cache = URLCache(memoryCapacity: 5 * 1024 * 1024,
                         diskCapacity: 50 * 1024 * 1024,
                         directory: nil)
    return cache
}()

private let avatarURLSession: URLSession = {
    let cfg = URLSessionConfiguration.default
    cfg.urlCache = avatarURLCache
    cfg.requestCachePolicy = .returnCacheDataElseLoad
    cfg.timeoutIntervalForRequest = 10
    cfg.timeoutIntervalForResource = 30
    return URLSession(configuration: cfg)
}()

/// Circular avatar that prefers the user's real GitLab profile picture
/// and falls back to coloured initials while loading or if the URL is
/// missing/unreachable.  Image bytes are cached via a shared URLCache so
/// repeated renders (Gantt rows, Issue board) don't re-fetch.
/// Usage: `UserAvatar(user: someUser, size: 22)`.
struct UserAvatar: View {
    let name: String
    let id: Int
    let avatarUrl: String?
    var size: CGFloat = 24

    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var config: AppConfig

    @State private var loadedImage: NSImage?

    var body: some View {
        ZStack {
            initialsFallback
            if let img = loadedImage {
                Image(nsImage: img)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
                    .frame(width: size, height: size)
                    .clipShape(Circle())
            }
        }
        .frame(width: size, height: size)
        .task(id: resolvedAvatarURL) {
            await loadAvatar()
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(name)
    }

    @MainActor
    private func loadAvatar() async {
        loadedImage = nil
        guard let url = resolvedAvatarURL else { return }
        var req = URLRequest(url: url)
        req.cachePolicy = .returnCacheDataElseLoad
        do {
            let (data, _) = try await avatarURLSession.data(for: req)
            if let img = NSImage(data: data) {
                loadedImage = img
            }
        } catch {
            // Swallow — initials fallback already visible.
        }
    }

    /// GitLab sometimes returns avatar_url as a relative path
    /// ("/uploads/-/system/user/avatar/<id>/avatar.png"). Resolve those
    /// against the user's configured GitLab base URL so we can actually
    /// fetch them; absolute URLs pass through unchanged.
    private var resolvedAvatarURL: URL? {
        guard let raw = avatarUrl?.trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty else { return nil }
        if let abs = URL(string: raw), abs.scheme != nil { return abs }
        let base = config.gitLabBaseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !base.isEmpty, let baseURL = URL(string: base) else { return nil }
        return URL(string: raw, relativeTo: baseURL)?.absoluteURL
    }

    private var initialsFallback: some View {
        let color = ColorPalette.color(for: id)
        return ZStack {
            Circle().fill(color.opacity(0.20))
            Text(String(name.prefix(1)).uppercased())
                .font(.system(size: size * 0.38, weight: .bold))
                .foregroundStyle(color)
        }
        .frame(width: size, height: size)
    }
}

extension UserAvatar {
    init(user: GitLabUser, size: CGFloat = 24) {
        self.name = user.name
        self.id = user.id
        self.avatarUrl = user.avatarUrl
        self.size = size
    }
}
