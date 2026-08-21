import SwiftUI

/// Collects what the "add an MCP server" flows cannot infer.
///
/// Two jobs, because they share almost all of their form:
///   • `.catalogArg` — a catalog entry declared `requiresArg` (filesystem's
///     allowed directory, DBHub's DSN). Registering without it produces a
///     server that runs but exposes nothing, so the server refuses and this
///     asks instead.
///   • `.manual` — anything not in the catalog. The registry has always
///     accepted a hand-written server, but nothing in the UI ever offered it,
///     so the only way in was importing what your Claude/Codex CLI already had.
struct McpAddSheet: View {
    enum Mode: Identifiable {
        case catalogArg(LlmIdeAPIClient.McpCatalogEntry)
        case manual

        var id: String {
            switch self {
            case .catalogArg(let e): return "catalog:\(e.id)"
            case .manual: return "manual"
            }
        }
    }

    let mode: Mode
    /// Called with everything needed for one add call. `catalogId` is set for
    /// the catalog flow, the transport fields for the manual one.
    let onAdd: (_ catalogId: String?, _ arg: String?, _ name: String?,
                _ transport: String?, _ command: String?, _ args: [String]?, _ url: String?) -> Void

    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var theme: ThemeStore

    @State private var argValue = ""
    @State private var name = ""
    @State private var transport = "stdio"
    @State private var commandLine = ""
    @State private var urlString = ""

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            header
            Divider()
            switch mode {
            case .catalogArg(let entry): catalogForm(entry)
            case .manual: manualForm
            }
            Spacer(minLength: 0)
            footer
        }
        .padding(Spacing.lg)
        .frame(width: 460)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(Typography.title).foregroundStyle(theme.current.text)
            Text(subtitle).font(Typography.caption).foregroundStyle(theme.current.textMuted)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var title: String {
        switch mode {
        case .catalogArg(let e): return "Add \(e.name)"
        case .manual: return "Add an MCP server"
        }
    }

    private var subtitle: String {
        switch mode {
        case .catalogArg(let e): return e.description
        case .manual: return "A local server started as a subprocess, or a hosted one reached over HTTP."
        }
    }

    @ViewBuilder
    private func catalogForm(_ entry: LlmIdeAPIClient.McpCatalogEntry) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(entry.requiresArg?.label ?? "Value")
                .font(Typography.captionStrong).foregroundStyle(theme.current.textMuted)
            TextField(entry.requiresArg?.placeholder ?? "", text: $argValue)
                .textFieldStyle(.roundedBorder)
            if let cmd = entry.command {
                Text("Runs: \(([cmd] + (entry.args ?? [])).joined(separator: " ")) \(argValue)")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(theme.current.textMuted)
                    .lineLimit(2)
            }
        }
    }

    @ViewBuilder
    private var manualForm: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            LabeledRow("Name") {
                TextField("my-server", text: $name).textFieldStyle(.roundedBorder)
            }
            LabeledRow("Transport") {
                Picker("", selection: $transport) {
                    Text("Local (stdio)").tag("stdio")
                    Text("Hosted (http)").tag("http")
                    Text("Hosted (sse)").tag("sse")
                }
                .labelsHidden().pickerStyle(.segmented)
            }
            if transport == "stdio" {
                LabeledRow("Command") {
                    TextField("npx -y @modelcontextprotocol/server-memory", text: $commandLine)
                        .textFieldStyle(.roundedBorder)
                }
                Text("Split on spaces — the first word is the command, the rest its arguments.")
                    .font(Typography.caption).foregroundStyle(theme.current.textMuted)
            } else {
                LabeledRow("URL") {
                    TextField("https://mcp.example.com/mcp", text: $urlString)
                        .textFieldStyle(.roundedBorder)
                }
                Text("Servers behind OAuth sign in through the CLI (`claude mcp login <name>`) — no token needed here.")
                    .font(Typography.caption).foregroundStyle(theme.current.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var footer: some View {
        HStack {
            Spacer()
            Button("Cancel") { dismiss() }
            Button("Add") { submit() }
                .buttonStyle(.borderedProminent)
                .disabled(!canSubmit)
        }
    }

    private var canSubmit: Bool {
        switch mode {
        case .catalogArg: return !argValue.trimmingCharacters(in: .whitespaces).isEmpty
        case .manual:
            if transport == "stdio" { return !commandLine.trimmingCharacters(in: .whitespaces).isEmpty }
            return !urlString.trimmingCharacters(in: .whitespaces).isEmpty
        }
    }

    private func submit() {
        switch mode {
        case .catalogArg(let entry):
            onAdd(entry.id, argValue.trimmingCharacters(in: .whitespaces), nil, nil, nil, nil, nil)
        case .manual:
            let trimmedName = name.trimmingCharacters(in: .whitespaces)
            let finalName = trimmedName.isEmpty ? nil : trimmedName
            if transport == "stdio" {
                let parts = commandLine.split(separator: " ").map(String.init).filter { !$0.isEmpty }
                guard let command = parts.first else { return }
                onAdd(nil, nil, finalName, "stdio", command, Array(parts.dropFirst()), nil)
            } else {
                onAdd(nil, nil, finalName, transport, nil, nil, urlString.trimmingCharacters(in: .whitespaces))
            }
        }
        dismiss()
    }

    /// Label above a field — the sheet is narrow, so stacked reads better than
    /// a leading-label grid.
    @ViewBuilder
    private func LabeledRow<Content: View>(_ label: String, @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(Typography.captionStrong).foregroundStyle(theme.current.textMuted)
            content()
        }
    }
}
