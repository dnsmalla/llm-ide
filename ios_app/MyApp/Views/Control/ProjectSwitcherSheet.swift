import SwiftUI
import SharedProtocol

/// Pick one of the Mac's recent projects to open on the Mac. Switching changes what the Mac is
/// showing, so it asks first; the Mac may still refuse (a run is active) and says why.
struct ProjectSwitcherSheet: View {
    @EnvironmentObject var store: ProjectsStore
    @Environment(\.dismiss) private var dismiss
    @State private var pending: ProjectInfo?

    var body: some View {
        NavigationStack {
            List {
                if let error = store.error {
                    Section { Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(DesignSystem.Typography.footnoteFont)
                        .foregroundColor(DesignSystem.Colors.danger) }
                }
                Section {
                    if !store.loaded {
                        HStack(spacing: DesignSystem.Spacing.sm) {
                            ProgressView()
                            Text("Loading projects…").font(DesignSystem.Typography.footnoteFont)
                                .foregroundColor(DesignSystem.Colors.textTertiary)
                        }
                    } else if store.projects.isEmpty {
                        Text("The Mac has no recent projects.").font(DesignSystem.Typography.footnoteFont)
                            .foregroundColor(DesignSystem.Colors.textTertiary)
                    }
                    ForEach(store.projects) { project in
                        Button { if project.id != store.active?.id { pending = project } } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(project.name).foregroundColor(DesignSystem.Colors.textPrimary)
                                    if let opened = project.lastOpenedAt {
                                        Text("Opened \(Date(epochSeconds: opened).relativeTimeShort())")
                                            .font(DesignSystem.Typography.captionFont)
                                            .foregroundColor(DesignSystem.Colors.textTertiary)
                                    }
                                }
                                Spacer()
                                if project.id == store.active?.id {
                                    Image(systemName: "checkmark").foregroundColor(DesignSystem.Colors.primary)
                                        .accessibilityLabel("Active")
                                } else if store.isSwitching && pending?.id == project.id {
                                    ProgressView()
                                }
                            }
                        }
                        .disabled(store.isSwitching)
                    }
                } footer: {
                    Text("This changes the project open on your Mac. It can't switch while a loop or auto task is running.")
                }
            }
            .scrollContentBackground(.hidden)
            .background(DesignSystem.Colors.background.ignoresSafeArea())
            .navigationTitle("Switch project")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarLeading) { Button("Done") { dismiss() } } }
            .task { store.refresh() }
            .confirmationDialog(pending.map { "Open “\($0.name)” on your Mac?" } ?? "", isPresented: Binding(
                get: { pending != nil && !store.isSwitching }, set: { if !$0 { pending = nil } }),
                titleVisibility: .visible) {
                Button("Open on Mac") { if let p = pending { store.switchTo(p) } }
                Button("Cancel", role: .cancel) { pending = nil }
            }
            .onChange(of: store.active) { _ in if !store.isSwitching && store.error == nil { dismiss() } }
        }
    }
}
