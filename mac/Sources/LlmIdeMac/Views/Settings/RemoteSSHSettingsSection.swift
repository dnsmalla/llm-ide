import SwiftUI

/// Lists SSH hosts discovered from ~/.ssh/config and connects to one by
/// opening a remote shell in the terminal panel. Read-only: hosts are managed
/// by editing ~/.ssh/config. Auth is delegated entirely to ssh/config.
struct RemoteSSHSettingsSection: View {
    @EnvironmentObject var theme: ThemeStore
    @Environment(TerminalPanelState.self) private var terminal

    @State private var hosts: [RemoteHost] = []

    var body: some View {
        SettingsSectionCard(icon: "network", title: "Remote / SSH") {
            VStack(alignment: .leading, spacing: Spacing.sm) {
                if hosts.isEmpty {
                    SettingsHint("No connectable hosts found in ~/.ssh/config. Add Host entries there to connect.")
                } else {
                    ForEach(hosts) { host in
                        hostRow(host)
                        if host.id != hosts.last?.id { Divider() }
                    }
                }

                HStack {
                    Button("Refresh") { hosts = SSHConfig.discover() }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                    Spacer()
                }
                .padding(.top, Spacing.xs)

                SettingsHint("Hosts are read from ~/.ssh/config (Include directives aren't expanded). Connecting opens a remote shell in the Terminal panel using your existing ssh keys/agent.")
            }
        }
        .onAppear { if hosts.isEmpty { hosts = SSHConfig.discover() } }
    }

    @ViewBuilder
    private func hostRow(_ host: RemoteHost) -> some View {
        HStack(spacing: Spacing.sm) {
            VStack(alignment: .leading, spacing: 2) {
                Text(host.alias)
                    .font(Typography.bodyStrong)
                    .foregroundStyle(theme.current.text)
                Text(host.subtitle)
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.textMuted)
            }
            Spacer()
            Button("Connect") { terminal.connectRemote(host: host) }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
        }
        .padding(.vertical, 2)
    }
}
