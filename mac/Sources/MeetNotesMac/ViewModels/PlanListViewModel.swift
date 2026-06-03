import Foundation
import Combine

/// Drives the Plan tab — fetches the list, fetches a selected plan,
/// surfaces loading + error states.  Network calls go through the
/// API client; this view-model just orchestrates state for SwiftUI.
@MainActor
final class PlanListViewModel: ObservableObject {
    @Published private(set) var summaries: [PlanSummary] = []
    @Published private(set) var selected: Plan?
    @Published private(set) var loadingList: Bool = false
    @Published private(set) var loadingDetail: Bool = false
    @Published private(set) var error: String?

    private let api: MeetNotesAPIClient
    init(api: MeetNotesAPIClient) { self.api = api }

    func refresh() async {
        loadingList = true
        error = nil
        defer { loadingList = false }
        do {
            summaries = try await api.listPlans()
        } catch {
            self.error = error.localizedDescription
        }
    }

    func open(id: String) async {
        loadingDetail = true
        error = nil
        defer { loadingDetail = false }
        do {
            selected = try await api.getPlan(id: id)
        } catch {
            self.error = error.localizedDescription
        }
    }

    func clear() {
        selected = nil
    }
}
