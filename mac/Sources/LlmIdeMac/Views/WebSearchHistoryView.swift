import SwiftUI

/// Displays web search history with quick re-search capability
struct WebSearchHistoryView: View {
    @ObservedObject var webSearch: WebSearchService
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject var theme: ThemeStore

    var body: some View {
        NavigationStack {
            List {
                if webSearch.searchHistory.isEmpty {
                    Text("No search history")
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .center)
                        .padding()
                } else {
                    ForEach(webSearch.searchHistory) { entry in
                        HStack {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(entry.query)
                                    .font(.system(size: 13))
                                Text("\(entry.resultCount) results • \(formatDate(entry.timestamp))")
                                    .font(.system(size: 11))
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Button("Search Again") {
                                // Trigger search again (placeholder for now)
                                dismiss()
                            }
                            .buttonStyle(.borderless)
                        }
                        .padding(.vertical, 4)
                    }
                }
            }
            .navigationTitle("Search History")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Clear") {
                        webSearch.clearHistory()
                    }
                    .disabled(webSearch.searchHistory.isEmpty)
                }
            }
        }
        .frame(minWidth: 400, minHeight: 300)
    }

    private func formatDate(_ date: Date) -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: date, relativeTo: Date())
    }
}
