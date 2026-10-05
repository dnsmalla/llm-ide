import Foundation
import Observation
import os

@MainActor
@Observable
public final class IncidentStore {
    public static let cap = 200
    public static let shared = IncidentStore(fileURL: defaultFileURL)

    public static var defaultFileURL: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("llm-ide", isDirectory: true)
            .appendingPathComponent("incidents.json")
    }

    public private(set) var incidents: [Incident] = []
    public private(set) var saveCount = 0

    private let fileURL: URL
    private let saveDelay: Duration
    @ObservationIgnored private var pendingSave: Task<Void, Never>?

    public init(fileURL: URL, saveDelay: Duration = .seconds(1)) {
        self.fileURL = fileURL
        self.saveDelay = saveDelay
        load()
    }

    public func upsert(_ incident: Incident) {
        if let i = incidents.firstIndex(where: { $0.id == incident.id }) {
            incidents[i].count += incident.count
            incidents[i].lastSeen = max(incidents[i].lastSeen, incident.lastSeen)
            incidents[i].message = incident.message
            incidents[i].stack = incident.stack ?? incidents[i].stack
            if incidents[i].status == .fixed {
                incidents[i].status = .new
                incidents[i].attempts += 1
                incidents[i].proposal = nil
            }
        } else {
            incidents.append(incident)
            evictIfNeeded()
        }
        scheduleSave()
    }

    public func update(id: String, _ mutate: (inout Incident) -> Void) {
        guard let i = incidents.firstIndex(where: { $0.id == id }) else { return }
        mutate(&incidents[i])
        scheduleSave()
    }

    public func candidatesForTriage() -> [Incident] {
        // SDK adoption records have no error to triage.
        incidents.filter { $0.status == .new && !SdkAdoption.isRecord($0) }
            .sorted { ($0.count, $0.lastSeen) > ($1.count, $1.lastSeen) }
    }

    public func flush() {
        pendingSave?.cancel()
        pendingSave = nil
        save()
    }

    private func evictIfNeeded() {
        while incidents.count > Self.cap {
            guard let victim = incidents.enumerated()
                .filter({ $0.element.status != .fixing && $0.element.status != .proposed })
                .min(by: { $0.element.lastSeen < $1.element.lastSeen }) else { return }
            incidents.remove(at: victim.offset)
        }
    }

    private func scheduleSave() {
        guard pendingSave == nil else { return }
        let delay = saveDelay
        pendingSave = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled else { return }
            self?.pendingSave = nil
            self?.save()
        }
    }

    private func save() {
        saveCount += 1
        do {
            try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(),
                                                    withIntermediateDirectories: true)
            let encoder = JSONEncoder()
            encoder.dateEncodingStrategy = .iso8601
            try encoder.encode(incidents).write(to: fileURL, options: .atomic)
        } catch {
            // Info, not error: an error-level line here would be recorded as an incident.
            Self.log.info("incident store save failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    private func load() {
        guard let data = try? Data(contentsOf: fileURL) else { return }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        if var decoded = try? decoder.decode([Incident].self, from: data) {
            // A `.fixing` incident with no run holding it is an orphan: the
            // app quit or crashed mid-triage, and nothing will ever answer
            // it, so it must re-enter the pool the next run can pick from.
            for i in decoded.indices where decoded[i].status == .fixing {
                decoded[i].status = .new
            }
            incidents = decoded
            return
        }
        let archive = fileURL.deletingLastPathComponent()
            .appendingPathComponent("\(fileURL.lastPathComponent).corrupt-\(Int(Date().timeIntervalSince1970))")
        try? FileManager.default.moveItem(at: fileURL, to: archive)
        Self.log.info("incident store was unreadable; archived to \(archive.lastPathComponent, privacy: .public)")
    }

    private static let log = Logger(subsystem: "com.llmide.macapp", category: "Incidents")
}
