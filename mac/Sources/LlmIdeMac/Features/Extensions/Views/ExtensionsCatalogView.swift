import SwiftUI

/// The Extensions catalog screen: what is installed (grouped by kind, with
/// switches, trust and scan badges, update / rollback / repair), a cached
/// catalog to browse, and install from a GitHub URL. The detail pane of the
/// Library's "Extensions" row.
struct ExtensionsCatalogView: View {
    @EnvironmentObject private var theme: ThemeStore
    @State private var model: ExtensionsCatalogModel

    init(api: LlmIdeAPIClient) {
        _model = State(initialValue: ExtensionsCatalogModel(api: api))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            if let notice = model.notice { noticeBanner(notice) }
            if model.catalogOff { catalogOffBanner }
            switch model.tab {
            case .installed: ExtensionsInstalledTab(model: model)
            case .browse: ExtensionsBrowseTab(model: model)
            case .install: ExtensionsInstallTab(model: model)
            }
        }
        // Cached read only: no GitHub or registry call happens on appear.
        .task { await model.loadInstalled() }
        .sheet(item: $model.pendingConsent) { request in
            ExtensionsConsentSheet(request: request,
                                   onConfirm: { Task { await model.confirmConsent() } },
                                   onCancel: { model.pendingConsent = nil })
                .environmentObject(theme)
        }
        .sheet(item: $model.preview) { state in
            ExtensionsUpdatePreviewSheet(state: state,
                                         onApply: { Task { await model.applyPreview() } },
                                         onCancel: { model.preview = nil })
                .environmentObject(theme)
        }
        .confirmationDialog(
            "Roll back \(model.pendingRollback?.name ?? "")?",
            isPresented: Binding(get: { model.pendingRollback != nil }, set: { if !$0 { model.pendingRollback = nil } }),
            titleVisibility: .visible, presenting: model.pendingRollback
        ) { item in
            Button("Roll Back") { Task { await model.rollback(item) } }
            Button("Cancel", role: .cancel) { model.pendingRollback = nil }
        } message: { item in
            Text("Restores the previous version (\(item.previous.map { ExtensionsCatalogPresentation.shortCommit($0.pinnedCommit) } ?? "none")) from the files kept on this Mac. Nothing is downloaded.")
        }
        .confirmationDialog(
            "Remove \(model.pendingUninstall?.name ?? "")?",
            isPresented: Binding(get: { model.pendingUninstall != nil }, set: { if !$0 { model.pendingUninstall = nil } }),
            titleVisibility: .visible, presenting: model.pendingUninstall
        ) { item in
            Button("Remove", role: .destructive) { Task { await model.uninstall(item) } }
            Button("Cancel", role: .cancel) { model.pendingUninstall = nil }
        } message: { _ in
            Text("Deletes the item, its switches and every stored version for your account.")
        }
    }

    private var header: some View {
        HStack(spacing: 12) {
            Text("Extensions").font(.title3.weight(.semibold))
            Picker("View", selection: $model.tab) {
                ForEach(ExtensionsCatalogModel.Tab.allCases) { tab in
                    Text(tab == .installed && model.updateCount > 0 ? "Installed (\(model.updateCount) update\(model.updateCount == 1 ? "" : "s"))" : tab.rawValue)
                        .tag(tab)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(maxWidth: 380)
            .accessibilityLabel("Extensions view")
            Spacer()
        }
        .padding(12)
    }

    private func noticeBanner(_ text: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: model.noticeIsError ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                .foregroundStyle(model.noticeIsError ? theme.current.danger : theme.current.success)
            Text(text).font(.callout).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
            Spacer(minLength: 0)
            Button { model.notice = nil } label: { Image(systemName: "xmark") }
                .buttonStyle(.plain)
                .accessibilityLabel("Dismiss message")
        }
        .padding(10)
        .background((model.noticeIsError ? theme.current.danger : theme.current.success).opacity(0.08))
        .accessibilityElement(children: .combine)
    }

    private var catalogOffBanner: some View {
        Label("The extension catalog is off on this server (LLMIDE_EXT_CATALOG=off). Install, update and refresh are unavailable; installed items can still be viewed.",
              systemImage: "power")
            .font(.callout)
            .foregroundStyle(theme.current.warning)
            .padding(10)
    }
}

// MARK: - Installed

struct ExtensionsInstalledTab: View {
    @EnvironmentObject private var theme: ThemeStore
    @Bindable var model: ExtensionsCatalogModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Button {
                        Task { await model.checkUpdates() }
                    } label: {
                        Label(model.checking ? "Checking…" : "Check for updates", systemImage: "arrow.triangle.2.circlepath")
                    }
                    .disabled(model.checking || model.items.isEmpty)
                    .help("Asks GitHub for the newest commit of each installed item. Downloads nothing.")
                    Button { Task { await model.loadInstalled() } } label: { Label("Reload", systemImage: "arrow.clockwise") }
                        .disabled(model.loading)
                    Spacer()
                }
                if model.corrupt {
                    Label("The installed record could not be read, so this list may be incomplete. Nothing was changed.",
                          systemImage: "exclamationmark.triangle")
                        .font(.callout).foregroundStyle(theme.current.warning)
                }
                if let error = model.loadError {
                    HStack {
                        Text("Couldn't read the installed list: \(error)").font(.callout).foregroundStyle(theme.current.danger)
                        Button("Retry") { Task { await model.loadInstalled() } }
                    }
                } else if model.loaded && model.items.isEmpty && !model.corrupt {
                    emptyState
                } else if !model.loaded {
                    ProgressView().controlSize(.small)
                }
                ForEach(model.groups, id: \.kind) { group in
                    VStack(alignment: .leading, spacing: 8) {
                        Label(ExtensionsCatalogPresentation.kindTitle(group.kind),
                              systemImage: ExtensionsCatalogPresentation.kindIcon(group.kind))
                            .font(.headline)
                            .accessibilityAddTraits(.isHeader)
                        ForEach(group.items) { item in
                            ExtensionsInstalledRow(model: model, item: item)
                        }
                    }
                }
            }
            .padding(14)
        }
    }

    private var emptyState: some View {
        VStack(spacing: 6) {
            Image(systemName: "shippingbox").font(.largeTitle).foregroundStyle(.tertiary)
            Text("Nothing installed from the catalog yet").font(.headline)
            Text("Browse the cached catalog or install from a GitHub URL. Installed items stay off until you switch them on.")
                .font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)
            HStack {
                Button("Browse") { model.tab = .browse }
                Button("Install from URL") { model.tab = .install }
            }
        }
        .frame(maxWidth: .infinity)
        .padding(24)
    }
}

struct ExtensionsInstalledRow: View {
    @EnvironmentObject private var theme: ThemeStore
    @Bindable var model: ExtensionsCatalogModel
    let item: ExtInstalledItem
    @State private var expanded = false

    private var busy: Bool { model.busy.contains(item.id) }
    private var hasUpdate: Bool { ExtensionsCatalogPresentation.hasUpdate(item) }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 10) {
                Toggle("", isOn: Binding(
                    get: { item.state.enabled },
                    set: { on in Task { if on { await model.requestEnable(item) } else { await model.disable(item) } } }))
                    .labelsHidden()
                    .toggleStyle(.switch)
                    .disabled(busy)
                    .accessibilityLabel("Enable \(item.name)")
                    .accessibilityValue(item.state.enabled ? "on" : "off")
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(item.name).font(.callout.weight(.semibold))
                        if let v = item.version { Text("v\(v)").font(.caption).foregroundStyle(.secondary) }
                        badges
                    }
                    if !item.description.isEmpty {
                        Text(item.description).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                    }
                    Text("\(ExtensionsCatalogPresentation.repoName(item.source.url)) at \(ExtensionsCatalogPresentation.shortCommit(item.pinnedCommit))")
                        .font(.caption2).foregroundStyle(.tertiary)
                        .help("Pinned commit \(item.pinnedCommit)")
                }
                Spacer(minLength: 0)
                if busy { ProgressView().controlSize(.small) }
                Button { expanded.toggle() } label: { Image(systemName: expanded ? "chevron.up" : "chevron.down") }
                    .buttonStyle(.plain)
                    .accessibilityLabel(expanded ? "Hide details for \(item.name)" : "Show details for \(item.name)")
            }
            actions
            if expanded { details }
        }
        .padding(10)
        .background(theme.current.surface, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(theme.current.border))
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder private var badges: some View {
        ExtBadge(text: ExtensionsCatalogPresentation.trustLabel(item.publisher.trust),
                 color: item.publisher.trust == "official" ? theme.current.success : theme.current.textMuted)
        if item.scan.count > 0 {
            ExtBadge(text: "\(item.scan.count) scan warning\(item.scan.count == 1 ? "" : "s")", color: theme.current.warning)
        }
        if !item.declared.executableKinds.isEmpty {
            ExtBadge(text: "runs code: " + ExtConsentKind.ordered(item.declared.executableKinds).joined(separator: ", "),
                     color: theme.current.warning)
        }
        if hasUpdate { ExtBadge(text: "update available", color: theme.current.accent) }
    }

    private var actions: some View {
        HStack(spacing: 8) {
            if hasUpdate {
                Button { Task { await model.openPreview(item) } } label: { Label("Review update…", systemImage: "arrow.down.circle") }
                    .buttonStyle(.borderedProminent)
                    .disabled(busy)
            }
            if item.previous != nil {
                Button { model.pendingRollback = item } label: { Label("Rollback", systemImage: "arrow.uturn.backward") }
                    .disabled(busy)
            }
            Button { Task { await model.repair(item) } } label: { Label("Repair", systemImage: "wrench.and.screwdriver") }
                .disabled(busy)
                .help("Verifies the stored files and re-downloads them at the pinned commit if they are damaged.")
            Button { Task { await model.checkUpdates(for: item.id) } } label: { Label("Check", systemImage: "arrow.triangle.2.circlepath") }
                .disabled(busy || model.checking)
            Spacer()
            Button(role: .destructive) { model.pendingUninstall = item } label: { Label("Remove", systemImage: "trash") }
                .disabled(busy)
        }
        .controlSize(.small)
    }

    @ViewBuilder private var details: some View {
        Divider()
        if !item.members.isEmpty {
            Text("Members").font(.caption.weight(.semibold))
            ForEach(item.members) { member in
                Toggle(isOn: Binding(
                    get: { !item.state.disabledMembers.contains(member.memberId) },
                    set: { on in Task { await model.setMember(item, memberId: member.memberId, checked: on) } })) {
                    HStack(spacing: 6) {
                        Text(member.name).font(.caption)
                        Text(member.type).font(.caption2).foregroundStyle(.secondary)
                        if member.executable { ExtBadge(text: "runs code", color: theme.current.warning) }
                    }
                }
                .toggleStyle(.checkbox)
                .disabled(busy)
                .accessibilityLabel("\(member.name), \(member.type) member")
            }
        }
        if !item.permissions.isEmpty {
            Text("What it can do").font(.caption.weight(.semibold))
            ForEach(Array(item.permissions.enumerated()), id: \.offset) { _, p in
                Label(p.text, systemImage: p.executable ? "exclamationmark.shield" : "checkmark.shield")
                    .font(.caption).foregroundStyle(p.executable ? theme.current.warning : theme.current.textMuted)
            }
        }
        if !item.scan.findings.isEmpty {
            Text("Scan warnings (advisory, not a safety verdict)").font(.caption.weight(.semibold))
            ExtFindingsList(findings: item.scan.findings, total: item.scan.count)
        }
        if let p = item.previous {
            Text("Previous version kept: \(p.version ?? "no version") at \(ExtensionsCatalogPresentation.shortCommit(p.pinnedCommit))")
                .font(.caption).foregroundStyle(.secondary)
        }
    }
}

struct ExtBadge: View {
    let text: String
    let color: Color
    var body: some View {
        Text(text)
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(color)
            .padding(.horizontal, 5).padding(.vertical, 1)
            .background(color.opacity(0.15))
            .clipShape(Capsule())
    }
}

struct ExtFindingsList: View {
    @EnvironmentObject private var theme: ThemeStore
    let findings: [ExtScanFinding]
    let total: Int
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            ForEach(Array(findings.prefix(20).enumerated()), id: \.offset) { _, f in
                VStack(alignment: .leading, spacing: 0) {
                    Text("\(f.rule) in \(f.file)\(f.line.map { ":\($0)" } ?? "")")
                        .font(.caption.weight(.medium)).foregroundStyle(theme.current.warning)
                    Text(f.detail).font(.caption2).foregroundStyle(.secondary)
                    if let e = f.excerpt, !e.isEmpty {
                        Text(e).font(.caption2.monospaced()).foregroundStyle(.tertiary).lineLimit(1)
                    }
                }
                .accessibilityElement(children: .combine)
            }
            if total > min(findings.count, 20) {
                Text("and \(total - min(findings.count, 20)) more").font(.caption2).foregroundStyle(.secondary)
            }
        }
    }
}

// MARK: - Install

struct ExtensionsInstallTab: View {
    @EnvironmentObject private var theme: ThemeStore
    @Bindable var model: ExtensionsCatalogModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("Install from a GitHub URL").font(.headline)
                Text("Only https://github.com/owner/repo is accepted, and only repositories on the server's allowed list. Installing downloads the repository at one pinned commit and scans it. Nothing is run, and the item stays off until you switch it on.")
                    .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                TextField("https://github.com/owner/repo", text: $model.installURL)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityLabel("GitHub repository URL")
                    .onSubmit { Task { await model.install() } }
                TextField("Folder inside the repository (optional)", text: $model.installPath)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityLabel("Folder inside the repository, optional")
                HStack {
                    Button { Task { await model.install() } } label: {
                        Label(model.installing ? "Installing…" : "Install", systemImage: "arrow.down.circle")
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(model.installing || model.installURL.trimmingCharacters(in: .whitespaces).isEmpty)
                    if model.installing { ProgressView().controlSize(.small) }
                }
                if let result = model.lastInstall { InstallResultCard(model: model, result: result) }
            }
            .padding(14)
        }
    }
}

/// What an install produced: the repository and the pinned commit, the scan
/// findings as warnings, and the (off) switch that leads to the consent sheet.
struct InstallResultCard: View {
    @EnvironmentObject private var theme: ThemeStore
    @Bindable var model: ExtensionsCatalogModel
    let result: ExtInstallResult

    var body: some View {
        let item = model.item(result.item.id) ?? result.item
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label(item.name, systemImage: ExtensionsCatalogPresentation.kindIcon(item.kind)).font(.headline)
                ExtBadge(text: ExtensionsCatalogPresentation.trustLabel(item.publisher.trust),
                         color: item.publisher.trust == "official" ? theme.current.success : theme.current.textMuted)
                Spacer()
                Button { model.dismissLastInstall() } label: { Image(systemName: "xmark") }
                    .buttonStyle(.plain).accessibilityLabel("Dismiss install result")
            }
            Text("\(ExtensionsCatalogPresentation.repoName(item.source.url)) pinned at \(item.pinnedCommit)")
                .font(.caption.monospaced()).textSelection(.enabled)
            if item.scan.count > 0 {
                Text("\(item.scan.count) scan warning\(item.scan.count == 1 ? "" : "s") (advisory; a heuristic, not a verdict)")
                    .font(.caption.weight(.semibold)).foregroundStyle(theme.current.warning)
                ExtFindingsList(findings: item.scan.findings, total: item.scan.count)
            } else {
                Text("The scan found nothing to warn about (it is a heuristic, not a verdict).")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if !item.declared.executableKinds.isEmpty {
                Text("It can run code: " + ExtConsentKind.ordered(item.declared.executableKinds).map(ExtConsentKind.title).joined(separator: ", ")
                     + ". You will be asked to consent to each kind when you switch it on.")
                    .font(.caption).foregroundStyle(theme.current.warning)
            }
            HStack {
                Toggle("Enable", isOn: Binding(
                    get: { item.state.enabled },
                    set: { on in Task { if on { await model.requestEnable(item) } else { await model.disable(item) } } }))
                    .toggleStyle(.switch)
                    .disabled(model.busy.contains(item.id))
                    .accessibilityLabel("Enable \(item.name)")
                Button("Show in Installed") { model.tab = .installed }
            }
        }
        .padding(12)
        .background(theme.current.surface, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(theme.current.border))
        .accessibilityElement(children: .contain)
    }
}

// MARK: - Browse

struct ExtensionsBrowseTab: View {
    @EnvironmentObject private var theme: ThemeStore
    @Bindable var model: ExtensionsCatalogModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                TextField("Search the cached catalog", text: $model.query)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityLabel("Search the cached catalog")
                    .onSubmit { Task { await model.search() } }
                Picker("Kind", selection: Binding(get: { model.kindFilter ?? "" }, set: { model.kindFilter = $0.isEmpty ? nil : $0 })) {
                    Text("All kinds").tag("")
                    ForEach(ExtensionsCatalogPresentation.kindOrder, id: \.self) { Text(ExtensionsCatalogPresentation.kindTitle($0)).tag($0) }
                }
                .frame(width: 140)
                .accessibilityLabel("Filter by kind")
                .onChange(of: model.kindFilter) { Task { await model.search() } }
                Button { Task { await model.search() } } label: { Image(systemName: "magnifyingglass") }
                    .accessibilityLabel("Search")
                Button { Task { await model.refreshCatalog() } } label: {
                    Label(model.refreshing ? "Refreshing…" : "Refresh", systemImage: "arrow.clockwise")
                }
                .disabled(model.refreshing)
                .help("Fetches the indexes from GitHub and the MCP registry (user-initiated; cached for 6 hours).")
            }
            .padding(12)
            Divider()
            content
        }
        // Cached read only; Refresh is the user's.
        .task { if !model.browseLoaded { await model.search() } }
        .confirmationDialog(
            "Install \(model.pendingBrowseInstall?.name ?? "")?",
            isPresented: Binding(get: { model.pendingBrowseInstall != nil }, set: { if !$0 { model.pendingBrowseInstall = nil } }),
            titleVisibility: .visible, presenting: model.pendingBrowseInstall
        ) { entry in
            Button("Install") { Task { await model.installFromCatalog(entry); model.tab = .install } }
            Button("Cancel", role: .cancel) { model.pendingBrowseInstall = nil }
        } message: { entry in
            Text("Downloads \(ExtensionsCatalogPresentation.repoName(entry.source.url ?? ""))\(entry.source.path.map { " (\($0))" } ?? "") at its current commit, pinned. Nothing is run and it stays off until you switch it on.")
        }
    }

    @ViewBuilder private var content: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                if let error = model.browseError {
                    Text("Couldn't read the catalog: \(error)").font(.callout).foregroundStyle(theme.current.danger)
                }
                if let page = model.page {
                    if ExtensionsCatalogPresentation.catalogNeverFetched(page.sources) {
                        emptyCard("The catalog has not been fetched yet",
                                  "Press Refresh to read the skill, plugin and MCP indexes. This contacts GitHub and the MCP registry once, on your request.")
                    } else if page.results.isEmpty {
                        emptyCard("No matches", "Nothing in the cached catalog matches. Try another search, or Refresh.")
                    }
                    ForEach(page.results) { entry in entryRow(entry) }
                    if page.total > page.results.count {
                        Text("Showing \(page.results.count) of \(page.total). Narrow the search to see more.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    sourcesFooter(page.sources)
                } else if !model.browseLoaded && model.browseError == nil {
                    ProgressView().controlSize(.small)
                }
            }
            .padding(14)
        }
    }

    private func emptyCard(_ title: String, _ text: String) -> some View {
        VStack(spacing: 4) {
            Image(systemName: "tray").font(.title).foregroundStyle(.tertiary)
            Text(title).font(.headline)
            Text(text).font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity).padding(20)
    }

    private func entryRow(_ entry: ExtCatalogEntry) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: ExtensionsCatalogPresentation.kindIcon(entry.kind)).frame(width: 20).foregroundStyle(theme.current.accent)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(entry.name).font(.callout.weight(.semibold))
                    ExtBadge(text: ExtensionsCatalogPresentation.kindTitle(entry.kind), color: theme.current.textMuted)
                    ExtBadge(text: entry.installable ? "installable" : "browse only",
                             color: entry.installable ? theme.current.success : theme.current.textMuted)
                    if entry.installed.isInstalled { ExtBadge(text: "installed", color: theme.current.accent) }
                }
                Text("\(entry.publisher) · \(entry.indexId)").font(.caption2).foregroundStyle(.tertiary)
                if !entry.description.isEmpty { Text(entry.description).font(.caption).foregroundStyle(.secondary).lineLimit(3) }
                if !entry.installable {
                    Text(ExtensionsCatalogPresentation.reasonText(entry.reason)).font(.caption).foregroundStyle(theme.current.warning)
                    if let url = entry.source.url, let link = URL(string: url) {
                        Link("Open repository", destination: link).font(.caption)
                    }
                }
            }
            Spacer(minLength: 0)
            if entry.installable && !entry.installed.isInstalled {
                Button("Install…") { model.pendingBrowseInstall = entry }
                    .disabled(model.installing)
                    .accessibilityLabel("Install \(entry.name)")
            }
        }
        .padding(10)
        .background(theme.current.surface, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(theme.current.border))
        .accessibilityElement(children: .contain)
    }

    private func sourcesFooter(_ sources: [ExtCatalogSource]) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Indexes").font(.caption.weight(.semibold))
            ForEach(sources) { s in
                Text("\(s.title): \(ExtensionsCatalogPresentation.sourceStatusText(s))")
                    .font(.caption2).foregroundStyle(s.status == "error" ? theme.current.warning : theme.current.textMuted)
            }
        }
        .padding(.top, 6)
    }
}

// MARK: - Sheets

/// Names every kind of code the item can run and requires a tick for each
/// before the item is switched on (or an update that adds them is applied).
struct ExtensionsConsentSheet: View {
    @EnvironmentObject private var theme: ThemeStore
    let request: ExtensionsCatalogModel.ConsentRequest
    let onConfirm: () -> Void
    let onCancel: () -> Void
    @State private var agreed: Set<String> = []

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("\(request.itemName) can run code").font(.headline)
            Text("Switching it on lets the following run on this Mac, for the pinned commit \(ExtensionsCatalogPresentation.shortCommit(request.commit)) only. Tick each one you accept.")
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            ForEach(request.lines) { line in
                Toggle(isOn: Binding(get: { agreed.contains(line.kind) },
                                     set: { on in if on { agreed.insert(line.kind) } else { agreed.remove(line.kind) } })) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(line.title).font(.callout.weight(.semibold))
                        Text(line.detail).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                }
                .toggleStyle(.checkbox)
                .accessibilityLabel("Allow \(line.title)")
            }
            HStack {
                Spacer()
                Button("Cancel", role: .cancel) { onCancel() }
                Button(request.purpose == .enable ? "Switch On" : "Update") { onConfirm() }
                    .buttonStyle(.borderedProminent)
                    .disabled(agreed.count < request.lines.count)
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 480)
    }
}

/// The update preview: file diff, new executable kinds flagged, scan delta.
struct ExtensionsUpdatePreviewSheet: View {
    @EnvironmentObject private var theme: ThemeStore
    let state: ExtensionsCatalogModel.PreviewState
    let onApply: () -> Void
    let onCancel: () -> Void

    var body: some View {
        let p = state.preview
        VStack(alignment: .leading, spacing: 10) {
            Text("Update \(state.item.name)").font(.headline)
            Text("\(ExtensionsCatalogPresentation.shortCommit(p.from)) to \(ExtensionsCatalogPresentation.shortCommit(p.to))"
                 + (p.version.from != p.version.to ? " (version \(p.version.from ?? "none") to \(p.version.to ?? "none"))" : ""))
                .font(.caption.monospaced())
            if !p.flags.isEmpty {
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(p.flags, id: \.self) { flag in
                        Label(ExtensionsCatalogPresentation.flagText(flag), systemImage: "exclamationmark.triangle.fill")
                            .font(.callout.weight(.medium)).foregroundStyle(theme.current.warning)
                    }
                }
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    if !p.executable.newKinds.isEmpty {
                        section("New code that can run") {
                            Text(p.executable.newKinds.map(ExtConsentKind.title).joined(separator: ", "))
                                .font(.caption).foregroundStyle(theme.current.warning)
                            ForEach(p.executable.newMembers, id: \.memberId) { m in
                                Text("\(m.type): \(m.name)").font(.caption.monospaced())
                            }
                        }
                    }
                    section("Files: \(p.files.counts.added) added, \(p.files.counts.removed) removed, \(p.files.counts.changed) changed") {
                        ForEach(p.files.added, id: \.path) { Text("+ \($0.path) (\($0.size) B)").font(.caption.monospaced()).foregroundStyle(theme.current.success) }
                        ForEach(p.files.removed, id: \.path) { Text("- \($0.path) (\($0.size) B)").font(.caption.monospaced()).foregroundStyle(theme.current.danger) }
                        ForEach(p.files.changed, id: \.path) { Text("~ \($0.path) (\($0.before) to \($0.after) B)").font(.caption.monospaced()) }
                        if p.files.truncated { Text("The list is truncated.").font(.caption2).foregroundStyle(.secondary) }
                    }
                    section("Scan: \(p.scan.before.count) before, \(p.scan.after.count) after, \(p.scan.resolvedCount) resolved") {
                        if p.scan.newFindings.isEmpty {
                            Text("No new warnings (advisory heuristic).").font(.caption).foregroundStyle(.secondary)
                        } else {
                            ExtFindingsList(findings: p.scan.newFindings, total: p.scan.newFindings.count)
                        }
                    }
                    if p.wasEnabled && !p.staysEnabledWithoutConsent {
                        Text("It is on now. It will be switched off after the update unless you consent to the code it can run.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            .frame(maxHeight: 320)
            HStack {
                Spacer()
                Button("Cancel", role: .cancel) { onCancel() }
                Button(p.consent.required ? "Continue…" : "Apply Update") { onApply() }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 520)
    }

    private func section<C: View>(_ title: String, @ViewBuilder _ body: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title).font(.caption.weight(.semibold))
            body()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Library sidebar row

/// The Library sidebar's **Extensions** section: one row that opens the
/// catalog screen (installed / browse / install).
struct ExtensionsCatalogLibrarySection: View {
    let isExpanded: Binding<Bool>
    @EnvironmentObject private var theme: ThemeStore

    var body: some View {
        Section {
            if isExpanded.wrappedValue {
                HStack(spacing: 8) {
                    Image(systemName: "shippingbox").foregroundStyle(theme.current.categoryTeal).frame(width: 18)
                    Text("Browse & manage").font(.callout)
                    Spacer(minLength: 0)
                }
                .padding(.vertical, 2)
                .tag(LibrarySelection.extensionsCatalog)
                .accessibilityLabel("Extensions: browse and manage")
            }
        } header: {
            LibrarySectionHeader(title: "Extensions", icon: "shippingbox", tint: theme.current.categoryTeal,
                                 count: 0, isExpanded: isExpanded) { EmptyView() }
        }
    }
}
