import SwiftUI

struct GanttFilterBar: View {
    @ObservedObject var vm: GanttViewModel
    @EnvironmentObject var theme: ThemeStore

    var body: some View {
        let t = theme.current
        HStack(spacing: 0) {
            // Search field
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 11))
                    .foregroundStyle(t.textMuted)
                TextField("Search issues…", text: $vm.searchText)
                    .textFieldStyle(.plain)
                    .font(.system(size: 12))
                if !vm.searchText.isEmpty {
                    Button { vm.searchText = "" } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 10))
                            .foregroundStyle(t.textMuted)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Clear search")
                    .help("Clear search")
                }
            }
            .padding(.horizontal, 10).padding(.vertical, 5)
            .background(RoundedRectangle(cornerRadius: 7).fill(t.surface2.opacity(0.8)))
            .overlay(RoundedRectangle(cornerRadius: 7).stroke(t.border.opacity(0.6), lineWidth: 1))
            .frame(minWidth: 150, maxWidth: 220)
            .padding(.leading, 14)

            tabDivider(t: t)

            // State filter — All / Open / Closed
            stateSegment(label: "All",    value: "all",    t: t)
            stateSegment(label: "Open",   value: "opened", t: t)
            stateSegment(label: "Closed", value: "closed", t: t)

            tabDivider(t: t)

            // Milestone pill
            filterPillMenu(
                icon: "flag",
                label: vm.selectedMilestoneIds.isEmpty
                    ? "Milestone"
                    : "Milestone (\(vm.selectedMilestoneIds.count))",
                isActive: !vm.selectedMilestoneIds.isEmpty,
                t: t
            ) {
                Button("Clear") { vm.selectedMilestoneIds.removeAll() }
                Divider()
                ForEach(vm.activeMilestones, id: \.id) { m in
                    Button {
                        if vm.selectedMilestoneIds.contains(m.id) {
                            vm.selectedMilestoneIds.remove(m.id)
                        } else {
                            vm.selectedMilestoneIds.insert(m.id)
                        }
                    } label: {
                        Label(m.title, systemImage: vm.selectedMilestoneIds.contains(m.id) ? "checkmark" : "")
                    }
                }
            }

            // Assignee pill
            filterPillMenu(
                icon: "person",
                label: vm.selectedAssigneeIds.isEmpty
                    ? "Assignee"
                    : "Assignee (\(vm.selectedAssigneeIds.count))",
                isActive: !vm.selectedAssigneeIds.isEmpty,
                t: t
            ) {
                Button("Clear") { vm.selectedAssigneeIds.removeAll() }
                Divider()
                ForEach(vm.activeAssignees, id: \.id) { u in
                    Button {
                        if vm.selectedAssigneeIds.contains(u.id) {
                            vm.selectedAssigneeIds.remove(u.id)
                        } else {
                            vm.selectedAssigneeIds.insert(u.id)
                        }
                    } label: {
                        Label(u.displayName, systemImage: vm.selectedAssigneeIds.contains(u.id) ? "checkmark" : "")
                    }
                }
            }

            // Label pill
            if !vm.activeLabels.isEmpty {
                filterPillMenu(
                    icon: "tag",
                    label: vm.selectedLabels.isEmpty
                        ? "Label"
                        : "Label (\(vm.selectedLabels.count))",
                    isActive: !vm.selectedLabels.isEmpty,
                    t: t
                ) {
                    Button("Clear") { vm.selectedLabels.removeAll() }
                    Divider()
                    ForEach(vm.activeLabels.prefix(30), id: \.self) { lbl in
                        Button {
                            if vm.selectedLabels.contains(lbl) {
                                vm.selectedLabels.remove(lbl)
                            } else {
                                vm.selectedLabels.insert(lbl)
                            }
                        } label: {
                            Label(lbl, systemImage: vm.selectedLabels.contains(lbl) ? "checkmark" : "")
                        }
                    }
                }
            }

            // Date range picker pill
            GanttDateRangePicker(start: $vm.rangeStart, end: $vm.rangeEnd)

            tabDivider(t: t)

            // Hide undated toggle button
            Button { vm.hideBlankRows.toggle() } label: {
                HStack(spacing: 5) {
                    Image(systemName: vm.hideBlankRows ? "checkmark.square.fill" : "square")
                        .font(.system(size: 11))
                        .foregroundStyle(vm.hideBlankRows ? t.accent : t.textMuted)
                    Text("Hide undated")
                        .font(.system(size: 11, weight: vm.hideBlankRows ? .medium : .regular))
                        .foregroundStyle(vm.hideBlankRows ? t.accent : t.textMuted)
                }
                .padding(.horizontal, 8).padding(.vertical, 5)
                .background(RoundedRectangle(cornerRadius: 6).fill(vm.hideBlankRows ? t.accent.opacity(0.08) : Color.clear))
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(vm.hideBlankRows ? t.accent.opacity(0.3) : Color.clear, lineWidth: 1))
            }
            .buttonStyle(.plain)
            .padding(.leading, 8)

            Spacer(minLength: 0)

            // Issue count
            Text("\(vm.filteredIssues.count) / \(vm.issues.count)")
                .font(.system(size: 11, weight: .medium, design: .monospaced))
                .foregroundStyle(t.textMuted)
                .padding(.trailing, 20)
        }
        .frame(height: 42)
        .background(t.body)
    }

    // MARK: - Helpers

    private func stateSegment(label: String, value: String, t: Theme) -> some View {
        let active = vm.stateFilter == value
        return Button { vm.stateFilter = value } label: {
            Chip(icon: nil, label: label, active: active)
        }
        .buttonStyle(.plain)
        .padding(.leading, value == "all" ? 4 : 2)
    }

    private func tabDivider(t: Theme) -> some View {
        Rectangle()
            .fill(t.border.opacity(0.8))
            .frame(width: 1, height: 18)
            .padding(.horizontal, 12)
    }

    private func filterPillMenu<C: View>(
        icon: String,
        label: String,
        isActive: Bool,
        t: Theme,
        @ViewBuilder content: () -> C
    ) -> some View {
        Menu { content() } label: {
            HStack(spacing: 4) {
                Image(systemName: icon).font(.system(size: 10, weight: .medium))
                Text(label)
                    .font(.system(size: 12, weight: isActive ? .medium : .regular))
                    .lineLimit(1)
                Image(systemName: "chevron.down").font(.system(size: 8, weight: .semibold))
            }
            .foregroundStyle(isActive ? t.accent : t.textMuted)
            .padding(.horizontal, 9).padding(.vertical, 5)
            .background(RoundedRectangle(cornerRadius: 6).fill(isActive ? t.accent.opacity(0.08) : Color.clear))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(isActive ? t.accent.opacity(0.35) : t.border.opacity(0.7), lineWidth: 1))
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .padding(.leading, 8)
    }
}

// MARK: - Date range picker

struct GanttDateRangePicker: View {
    @Binding var start: Date?
    @Binding var end: Date?
    @EnvironmentObject var theme: ThemeStore
    @State private var showPopover = false

    private var isActive: Bool { start != nil || end != nil }

    var body: some View {
        let t = theme.current
        Button { showPopover.toggle() } label: {
            HStack(spacing: 4) {
                Image(systemName: "calendar").font(.system(size: 10, weight: .medium))
                Text(label).font(.system(size: 12)).lineLimit(1)
                Image(systemName: "chevron.down").font(.system(size: 8, weight: .semibold))
            }
            .foregroundStyle(isActive ? t.accent : t.textMuted)
            .padding(.horizontal, 9).padding(.vertical, 5)
            .background(RoundedRectangle(cornerRadius: 6).fill(isActive ? t.accent.opacity(0.08) : Color.clear))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(isActive ? t.accent.opacity(0.35) : t.border.opacity(0.7), lineWidth: 1))
        }
        .buttonStyle(.plain)
        .padding(.leading, 8)
        .popover(isPresented: $showPopover) {
            VStack(alignment: .leading, spacing: 12) {
                Text("Date Range").font(.headline)
                DatePicker("From", selection: Binding(
                    get: { start ?? Date() },
                    set: { start = $0 }
                ), displayedComponents: .date)
                DatePicker("Until", selection: Binding(
                    get: { end ?? Date() },
                    set: { end = $0 }
                ), displayedComponents: .date)
                HStack {
                    Button("Clear") { start = nil; end = nil }
                    Spacer()
                    Button("Done") { showPopover = false }
                        .keyboardShortcut(.defaultAction)
                }
            }
            .padding(16)
            .frame(width: 280)
        }
    }

    private var label: String {
        switch (start, end) {
        case (nil, nil):       return "Any date"
        case (let s?, nil):    return "From \(AppDateFormatter.dateOnly(s))"
        case (nil, let e?):    return "Until \(AppDateFormatter.dateOnly(e))"
        case (let s?, let e?): return "\(AppDateFormatter.dateOnly(s)) → \(AppDateFormatter.dateOnly(e))"
        }
    }
}
