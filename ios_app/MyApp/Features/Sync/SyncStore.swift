import Foundation
import CryptoKit
import Security
import UIKit
import SharedProtocol

/// The iPhone's sync tier: with the desktop off, read the last encrypted snapshot and queue chat prompts, from MEGA, Box
/// or the user's own server. Which one is fixed by the pairing's `st` (`storeKind`); only that client is ever used.
@MainActor
final class SyncStore: ObservableObject {
    enum Phase: Equatable { case off, needsPassword, ready, removed }
    enum EnrollStep: Equatable { case login, working(String), sas(String), done, failed(String) }
    struct Queued: Codable, Identifiable, Equatable {
        let id: String
        let text: String
        let issuedAtMs: Int
        /// The project the prompt was queued for (v2); nil means the phone chat (v1). Absent in older queue files.
        var projectId: String?
        /// A one-line explanation shown under the prompt (the older-desktop fallback).
        var note: String?
        var answer: String?
        var code: String?
        var isPending: Bool { answer == nil && code == nil }
    }
    private struct StoredKeys: Codable { var secureEnclave: Bool; var signing: Data; var ecdh: Data }
    private struct StoredMega: Codable { var email: String; var folder: String; var session: MegaClient.Session }
    private struct StoredBox: Codable { var folder: String; var app: BoxClient.App; var tokens: BoxClient.Tokens }

    @Published private(set) var phase: Phase = .off
    @Published private(set) var snapshot: SyncSnapshot?
    @Published private(set) var queued: [Queued] = []
    @Published private(set) var lastError: String?
    @Published private(set) var refreshing = false
    @Published private(set) var enrollStep: EnrollStep?
    @Published private(set) var megaEmail = ""
    /// Projects the phone knew in its last live session, for the queue's project picker. Bounded, ids and names only.
    @Published private(set) var knownProjects: [SyncProjectChoice] = []
    /// The project that was selected live when the list was last noted; the picker defaults to it.
    @Published private(set) var lastSelectedProjectId: String?

    private var device: SyncDevice?
    private var mega: MegaClient?
    private var server: SyncHttpsClient?
    private var box: BoxClient?
    @Published private(set) var storeKind: SyncStoreKind = .mega
    private var pendingPair: SyncPair?
    /// The claim prepared for `pendingPair`, kept across retries so a retry rewrites the same claim (contract 4c).
    private var prepared: (device: SyncDevice, stored: StoredKeys)?
    /// The name in the prepared claim; a retry cannot change it.
    var preparedName: String? { prepared?.device.state.name }
    private var enrollTask: Task<Void, Never>?
    private var foregroundTask: Task<Void, Never>?
    private var nowMs: Int { Int(Date().timeIntervalSince1970 * 1000) }
    /// The storage the paired device uses (`storeKind` follows a pairing in progress, for the sheet).
    private var activeKind: SyncStoreKind? { device.flatMap { SyncStoreKind(st: $0.state.pair.st) } }
    /// The client for `activeKind`; send and refresh use only this one.
    private var remote: SyncRemoteStore? {
        switch activeKind { case .mega: return mega; case .sftp: return server; case .box: return box; case nil: return nil }
    }
    private func attachBox(_ b: BoxClient, folder: String) {
        let app = b.app
        // A rotation from a client that is no longer the current one (signed out, replaced) is never written back.
        b.onTokens = { [weak self, weak b] t in
            guard let self, let b, self.box === b else { return }
            if !Keychain.save(StoredBox(folder: folder, app: app, tokens: t), .box) {
                self.lastError = "This phone couldn't save the Box sign-in to its Keychain. Connect Box again if sync stops."
            }
        }
        box = b
    }
    /// Before a new pairing's client takes over: end every older session and drop the other kinds' secrets.
    private func retireStores(keeping kind: SyncStoreKind) async {
        let (oldMega, oldBox) = (mega, box)
        mega = nil; box = nil; server = nil
        await oldMega?.logout(); await oldBox?.revoke()
        if kind != .mega { Keychain.delete(.mega) }
        if kind != .box { Keychain.delete(.box) }
    }

    init() { restore() }

    private func restore() {
        guard let st = Keychain.load(SyncDeviceState.self, .state), st.isEnrolled,
              let sk = Keychain.load(StoredKeys.self, .keys), let keys = try? Self.loadKeys(sk),
              let d = try? SyncDevice(state: st, keys: keys) else { return }
        guard let kind = SyncStoreKind(st: st.pair.st) else { return }
        attach(d)
        storeKind = kind
        queued = Self.read([Queued].self, "queue.json") ?? []
        loadProjects()
        switch kind {
        case .sftp:
            if let server = try? SyncHttpsClient(host: String(d.state.pair.st.dropFirst(5))) { self.server = server; phase = .ready } else { phase = .off }
        case .mega:
            if let m = Keychain.load(StoredMega.self, .mega) {
                megaEmail = m.email
                mega = MegaClient(folder: m.folder, session: m.session)
                phase = .ready
            } else { phase = .needsPassword }
        case .box:
            if let b = Keychain.load(StoredBox.self, .box), !b.tokens.refresh.isEmpty {
                attachBox(BoxClient(folder: b.folder, app: b.app, tokens: b.tokens), folder: b.folder)
                phase = .ready
            } else { phase = .needsPassword }
        }
        if let cache = Self.read([String: Data].self, "snapshot-cache.json"), !cache.isEmpty {
            Task { snapshot = (try? await d.readSnapshot(SyncDictionaryStore(files: cache), nowMs: nowMs)) ?? nil }
        }
    }

    private func attach(_ d: SyncDevice) {
        device = d
        d.onStateChange = { _ = Keychain.save($0, .state) }
    }

    private static func makeKeys() throws -> (SyncDeviceKeys, StoredKeys) {
        if SecureEnclaveSyncDeviceKeys.isAvailable {
            let k = try SecureEnclaveSyncDeviceKeys()
            return (k, StoredKeys(secureEnclave: true, signing: k.signingBlob, ecdh: k.ecdhBlob))
        }
        let k = SoftwareSyncDeviceKeys()
        return (k, StoredKeys(secureEnclave: false, signing: k.signing.rawRepresentation, ecdh: k.ecdh.rawRepresentation))
    }
    private static func loadKeys(_ s: StoredKeys) throws -> SyncDeviceKeys {
        if s.secureEnclave { return try SecureEnclaveSyncDeviceKeys(signingBlob: s.signing, ecdhBlob: s.ecdh) }
        return SoftwareSyncDeviceKeys(signing: try .init(rawRepresentation: s.signing), ecdh: try .init(rawRepresentation: s.ecdh))
    }

    func startEnrollment(_ pair: SyncPair) {
        guard let kind = SyncStoreKind(st: pair.st) else { lastError = "This code is not for a sync storage this app can open."; return }
        storeKind = kind
        pendingPair = pair; prepared = nil
        Task { try? await Task.sleep(nanoseconds: 600_000_000); enrollStep = .login }
    }
    func enroll(email: String, password: String, name: String) {
        guard let pair = pendingPair else { return }
        enrollTask?.cancel()
        enrollTask = Task { await runEnrollment(pair: pair, email: email, password: password, name: name) }
    }
    func enrollBox(name: String) {
        guard let pair = pendingPair, let bi = pair.bi, let bs = pair.bs else { return }
        let folder = String(pair.st.dropFirst("box:".count))
        enrollTask?.cancel()
        enrollTask = Task { await runBoxEnrollment(pair: pair, name: name, folder: folder, app: BoxClient.App(clientId: bi, clientSecret: bs)) }
    }
    func cancelEnrollment() {
        enrollTask?.cancel(); enrollTask = nil; enrollStep = nil; pendingPair = nil; prepared = nil
        if let k = activeKind { storeKind = k }  // back to the paired storage
    }
    /// Back to the sign-in form for the same QR; the prepared claim is reused.
    func retryEnrollment() { if pendingPair != nil { enrollStep = .login } }

    private func runEnrollment(pair: SyncPair, email: String, password: String, name: String) async {
        if pair.st.hasPrefix("sftp:") { await runServerEnrollment(pair: pair, name: name); return }
        let folder = String(pair.st.dropFirst("mega:".count))
        var client: MegaClient?
        do {
            enrollStep = .working("Signing in to MEGA…")
            let session = try await MegaClient.login(email: email, password: password)
            let c = MegaClient(folder: folder, session: session)
            client = c
            enrollStep = .working("Checking the desktop's key…")
            let (d, stored): (SyncDevice, StoredKeys)
            if let p = prepared { (d, stored) = p } else {
                let (keys, s) = try Self.makeKeys()
                let nd = try await SyncDevice.prepare(pair: pair, name: name, keys: keys, store: c, nowMs: nowMs)
                (d, stored) = (nd, s)
                prepared = (nd, s)
            }
            if d.state.userId == nil {  // not acked yet: (re)write the same claim; after the ack the slot may be gone
                _ = try await poll(SyncDevice.ackWindowMs) { try await d.writeClaim(c); return true }
            }
            enrollStep = .working("Waiting for the desktop…")
            // A retry after the ack: the slot is gone once the desktop confirmed, so go straight to the wrap.
            let sas: String?
            if d.state.userId != nil { sas = try await d.readAck(c) }
            else { sas = try await poll(SyncDevice.ackWindowMs) { try await d.readAck(c) } }
            if let sas {
                enrollStep = .sas(sas)
                UIAccessibility.post(notification: .announcement, argument: "Code ready. Compare it with the desktop.")
            }
            _ = try await poll(SyncDevice.wrapWindowMs) { try await d.readWrap(c, nowMs: self.nowMs) ? true : nil }
            // `c` stays the live session (`mega = c` below), so it is not logged out here; only a superseded `mega` is.
            let saved = Keychain.save(stored, .keys) && Keychain.save(d.state, .state)
                && Keychain.save(StoredMega(email: email, folder: folder, session: session), .mega)
            guard saved else {
                await c.logout()
                enrollStep = .failed("This phone couldn't save the sign-in to its Keychain. Try again.")
                return
            }
            prepared = nil; pendingPair = nil
            await retireStores(keeping: .mega)
            attach(d); mega = c; megaEmail = email
            queued = []; Self.write(queued, "queue.json")
            phase = .ready; enrollStep = .done
            await refresh()
        } catch is CancellationError {
            if let client { Task { await client.logout() } }  // a new task: this one is cancelled
        } catch {
            await client?.logout()
            enrollStep = .failed(Self.message(for: error))
        }
    }

    private func runServerEnrollment(pair: SyncPair, name: String) async {
        do {
            enrollStep = .working("Connecting to your server…")
            let store = try SyncHttpsClient(host: String(pair.st.dropFirst("sftp:".count)))
            enrollStep = .working("Checking the desktop's key…")
            let (d, stored): (SyncDevice, StoredKeys)
            if let p = prepared { (d, stored) = p } else {
                let (keys, s) = try Self.makeKeys()
                let nd = try await SyncDevice.prepare(pair: pair, name: name, keys: keys, store: store, nowMs: nowMs)
                (d, stored) = (nd, s); prepared = (nd, s)
            }
            if d.state.userId == nil { _ = try await poll(SyncDevice.ackWindowMs) { try await d.writeClaim(store); return true } }
            enrollStep = .working("Waiting for the desktop…")
            let sas = d.state.userId != nil ? try await d.readAck(store) : try await poll(SyncDevice.ackWindowMs) { try await d.readAck(store) }
            if let sas { enrollStep = .sas(sas); UIAccessibility.post(notification: .announcement, argument: "Code ready. Compare it with the desktop.") }
            _ = try await poll(SyncDevice.wrapWindowMs) { try await d.readWrap(store, nowMs: self.nowMs) ? true : nil }
            guard Keychain.save(stored, .keys) && Keychain.save(d.state, .state) else { enrollStep = .failed("This phone couldn't save the sign-in to its Keychain. Try again."); return }
            prepared = nil; pendingPair = nil
            await retireStores(keeping: .sftp)  // re-pairing to the own server drops the old MEGA or Box session secrets
            attach(d); server = store; megaEmail = ""
            queued = []; Self.write(queued, "queue.json"); setProjects([], selected: nil); phase = .ready; enrollStep = .done
            await refresh()
        } catch is CancellationError { } catch { enrollStep = .failed(Self.message(for: error)) }
    }

    private func runBoxEnrollment(pair: SyncPair, name: String, folder: String, app: BoxClient.App) async {
        var opened: BoxClient?
        do {
            enrollStep = .working("Signing in to Box…")
            let t = try await BoxAuth.signIn(app: app)
            let store = BoxClient(folder: folder, app: app, tokens: t)
            opened = store
            enrollStep = .working("Checking the desktop's key…")
            let (d, stored): (SyncDevice, StoredKeys)
            if let p = prepared { (d, stored) = p } else {
                let (keys, s) = try Self.makeKeys()
                let nd = try await SyncDevice.prepare(pair: pair, name: name, keys: keys, store: store, nowMs: nowMs)
                (d, stored) = (nd, s); prepared = (nd, s)
            }
            if d.state.userId == nil { _ = try await poll(SyncDevice.ackWindowMs) { try await d.writeClaim(store); return true } }
            enrollStep = .working("Waiting for the desktop…")
            let sas = d.state.userId != nil ? try await d.readAck(store) : try await poll(SyncDevice.ackWindowMs) { try await d.readAck(store) }
            if let sas { enrollStep = .sas(sas); UIAccessibility.post(notification: .announcement, argument: "Code ready. Compare it with the desktop.") }
            _ = try await poll(SyncDevice.wrapWindowMs) { try await d.readWrap(store, nowMs: self.nowMs) ? true : nil }
            await retireStores(keeping: .box)  // before the save: the old Box session must not overwrite the new tokens
            // store.tokens, not t: a rotation during the pairing replaced t, which Box has already spent.
            guard Keychain.save(stored, .keys) && Keychain.save(d.state, .state) && Keychain.save(StoredBox(folder: folder, app: app, tokens: store.tokens), .box) else {
                await store.revoke()
                enrollStep = .failed("This phone couldn't save the sign-in to its Keychain. Try again."); return
            }
            prepared = nil; pendingPair = nil; opened = nil
            attach(d); attachBox(store, folder: folder); megaEmail = ""
            queued = []; Self.write(queued, "queue.json"); setProjects([], selected: nil); phase = .ready; enrollStep = .done
            await refresh()
        } catch is CancellationError {
            if let opened { Task { await opened.revoke() } }  // a new task: this one is cancelled
        } catch {
            await opened?.revoke()
            enrollStep = .failed(Self.message(for: error))
        }
    }

    private func poll<T>(_ windowMs: Int, _ step: () async throws -> T?) async throws -> T {
        try await SyncRetry.poll(windowMs: windowMs, intervalMs: SyncDevice.ackPollMs, now: { self.nowMs },
                                 sleep: { try await Task.sleep(nanoseconds: $0) }, step)
    }

    func refresh() async {
        guard phase == .ready || phase == .removed, let device, !refreshing else { return }
        let store: SyncRemoteStore
        let b = box
        do {
            if activeKind == .mega, let mega { store = try await mega.pinned() } else if let r = remote { store = r } else { return }
        } catch { fail(error); return }
        refreshing = true; defer { refreshing = false }
        do {
            let rec = SyncRecordingStore(remote: store)
            if let s = try await device.readSnapshot(rec, nowMs: nowMs) {  // nil: the first snapshot is not there yet
                snapshot = s
                Self.write(rec.fetched, "snapshot-cache.json")
            }
            phase = .ready
            var resend: [(text: String, projectId: String?, note: String?)] = []
            let replies = try await device.readReplies(store, requestIds: queued.filter(\.isPending).map(\.id), nowMs: nowMs)
            for i in queued.indices {
                guard let r = replies[queued[i].id] else { continue }
                switch r {
                case .answered(let text, _): queued[i].answer = text
                case .failed(let code):
                    queued[i].code = code
                    if code == "stale_epoch" { resend.append((queued[i].text, queued[i].projectId, queued[i].note)) }
                    // An older desktop answers `refused` to every v2 request: resend once as v1 (a v1 entry never loops).
                    if code == "refused", queued[i].projectId != nil {
                        resend.append((queued[i].text, nil, Self.olderDesktopNote)); queued[i].code = "stale_epoch"
                    }
                }
            }
            let cutoff = nowMs - 7 * 86_400_000
            queued.removeAll { $0.issuedAtMs < cutoff || $0.code == "stale_epoch" }
            Self.write(queued, "queue.json")
            lastError = nil
            for r in resend { await send(r.text, projectId: r.projectId, note: r.note) }
        } catch { fail(error, box: b) }
    }

    /// True when the prompt was queued. On false the caller keeps the text and `lastError` says why.
    @discardableResult
    func send(_ text: String, projectId: String? = nil, note: String? = nil) async -> Bool {
        guard phase == .ready, let device else { lastError = "Sync isn't ready, so the prompt was not queued."; return false }
        guard let remote else { lastError = "No sync storage is connected, so the prompt was not queued."; return false }
        let b = box
        do {
            let id = try await device.sendRequest(remote, text: text, nowMs: nowMs, projectId: projectId)
            queued.append(Queued(id: id, text: text, issuedAtMs: nowMs, projectId: projectId, note: note))
            Self.write(queued, "queue.json"); lastError = nil
            return true
        } catch { fail(error, box: b); return false }
    }

    static let olderDesktopNote = "This desktop is older \u{2014} the prompt went to the phone chat"

    /// Remember the projects the live session knows, so the picker still works with the desktop off.
    /// An empty list from a failed or not-yet-loaded session never overwrites a good one.
    func noteProjects(_ projects: [(id: String, name: String)], selected: String?) {
        guard phase != .off, !projects.isEmpty else { return }
        setProjects(SyncProjectChoice.bounded(projects), selected: selected)
    }

    private struct StoredProjects: Codable { var projects: [SyncProjectChoice]; var selected: String? }
    private func setProjects(_ list: [SyncProjectChoice], selected: String?) {
        let sel = selected.flatMap { id in list.contains { $0.id == id } ? id : nil }
        guard list != knownProjects || sel != lastSelectedProjectId else { return }
        knownProjects = list; lastSelectedProjectId = sel
        Self.write(StoredProjects(projects: list, selected: sel), "projects.json")
    }
    private func loadProjects() {
        let stored = Self.read(StoredProjects.self, "projects.json")
        knownProjects = SyncProjectChoice.bounded((stored?.projects ?? []).map { ($0.id, $0.name) })
        lastSelectedProjectId = stored?.selected.flatMap { id in knownProjects.contains { $0.id == id } ? id : nil }
    }

    /// After Box refused the saved sign-in (revoked, or unused for 60 days): sign in again with the same Box app.
    func reconnectBox() async {
        guard activeKind == .box, let old = Keychain.load(StoredBox.self, .box) else { return }
        do {
            let t = try await BoxAuth.signIn(app: old.app)
            let b = BoxClient(folder: old.folder, app: old.app, tokens: t)
            guard Keychain.save(StoredBox(folder: old.folder, app: old.app, tokens: t), .box) else {
                await b.revoke(); lastError = "This phone couldn't save the Box sign-in to its Keychain. Try again."; return
            }
            let stale = box
            attachBox(b, folder: old.folder)
            await stale?.revoke()
            phase = .ready; lastError = nil
            await refresh()
        } catch { lastError = Self.message(for: error) }
    }

    /// After MEGA ended the session (ESID): sign in again with the same account. The email is not kept once the
    /// session is gone, so the user types it again.
    func signIn(email: String, password: String) async {
        guard let device, activeKind == .mega else { return }
        let folder = String(device.state.pair.st.dropFirst("mega:".count))
        do {
            let session = try await MegaClient.login(email: email, password: password)
            _ = Keychain.save(StoredMega(email: email, folder: folder, session: session), .mega)
            mega = MegaClient(folder: folder, session: session); megaEmail = email
            phase = .ready; lastError = nil
            await refresh()
        } catch { lastError = Self.message(for: error) }
    }

    func removeFromPhone() async {
        let (oldMega, oldBox) = (mega, box)
        mega = nil; box = nil; server = nil  // first: a refresh still in flight finds no current client to write back for
        await oldMega?.logout(); await oldBox?.revoke()
        for item in [Keychain.Item.state, .keys, .mega, .box] { Keychain.delete(item) }
        try? FileManager.default.removeItem(at: Self.dir)
        device = nil; mega = nil; box = nil; server = nil; snapshot = nil; queued = []; knownProjects = []; lastSelectedProjectId = nil; lastError = nil; megaEmail = ""
        phase = .off
    }

    func setForeground(_ on: Bool) {
        foregroundTask?.cancel(); foregroundTask = nil
        guard on else { return }
        foregroundTask = Task { [weak self] in
            await self?.refresh()
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 60_000_000_000)
                guard let self, !Task.isCancelled else { return }
                if self.queued.contains(where: \.isPending) { await self.refresh() }
            }
        }
    }

    /// `box`: the Box client the failed call used; a failure from one that is no longer current changes nothing.
    private func fail(_ error: Error, box failed: BoxClient? = nil) {
        if (error as? SyncHttpsClient.Failure) == .missing { phase = .removed }
        if let f = error as? BoxClient.Failure, f == .authFailed, let b = failed ?? box {
            guard b === box else { return }
            // Keep the folder and the Box app for Connect Box; the refused tokens are gone.
            _ = Keychain.save(StoredBox(folder: b.folder, app: b.app, tokens: BoxClient.Tokens(access: "", refresh: "")), .box)
            box = nil; phase = .needsPassword
        }
        if let f = error as? MegaClient.Failure, f == .sessionExpired || f == .authFailed {
            Keychain.delete(.mega); mega = nil; phase = .needsPassword
        }
        if (error as? SyncCryptoError)?.code == "removed" { phase = .removed }
        lastError = Self.message(for: error)
    }

    static func message(for error: Error) -> String {
        if let f = error as? MegaClient.Failure {
            switch f {
            case .authFailed: return "MEGA refused the email or password."
            case .mfaRequired: return "This MEGA account has two-step login on. Use the dedicated LLM-IDE account, with two-step login off."
            case .sessionExpired: return "Your MEGA sign-in ended. Sign in again."
            case .accountVersion: return "This MEGA account is too old for this app. Create a new dedicated account."
            case .rateLimited: return "MEGA is busy. Try again in a minute."
            case .quota: return "The MEGA account is over its storage or transfer quota."
            case .tooLarge, .badResponse, .http, .api: return "Couldn't read from MEGA (\(f))."
            }
        }
        if let f = error as? BoxClient.Failure {
            switch f {
            case .authFailed: return "Box ended the sign-in. Connect Box again."
            case .badClient: return "Box refused the app in this pairing code. Show a new code on the desktop."
            case .rateLimited: return "Box is busy. Try again in a minute."
            case .quota: return "The Box account is out of storage."
            case .missing: return "The sync folder was not found in this Box account. Sign in to the Box account the desktop uses."
            case .tooLarge, .badResponse, .http: return "Couldn't read from Box (\(f))."
            }
        }
        if let f = error as? SourceOAuthError {
            switch f {
            case .cancelled: return "Box sign-in was cancelled."
            case .stateMismatch, .failed: return "Box sign-in did not finish. Try again."
            default: return "Box sign-in did not finish (\(f)). Try again."
            }
        }
        if let f = error as? SyncHttpsClient.Failure {
            switch f {
            case .rateLimited: return "Your server is busy. Try again in a minute."
            case .missing: return "This iPhone's sync folder is gone from your server. Set it up again from the desktop."
            case .tooLarge, .badHost, .http: return "Couldn't reach your sync server (\(f))."
            }
        }
        if error is URLError { return "No connection to the sync storage." }
        switch (error as? SyncCryptoError)?.code {
        case "removed": return "This iPhone was removed from sync. Set it up again from the desktop."
        case "stale_manifest": return "The desktop hasn't updated sync for over a week. Open the desktop app to refresh, then pull to refresh here."
        case "updating": return "The desktop is updating the snapshot. Pull to refresh in a moment."
        case "too_long": return "That prompt is too long."
        case "empty": return "Type a prompt first."
        case "timeout": return "The desktop didn't answer in time. Start again on the desktop."
        case "bad_desktop_key": return "This code doesn't match the desktop's key. Start again on the desktop."
        case "ack_mismatch": return "Someone else answered this pairing code. Start again on the desktop and keep the code private."
        case let code?: return "The sync folder holds data this iPhone cannot verify (\(code)). Nothing from it is shown."
        case nil: return "Something went wrong."
        }
    }

    static func replyText(_ code: String) -> String {
        switch code {
        case "expired": return "Too old when the desktop saw it, or this iPhone's clock is wrong."
        case "quota": return "Today's limit for queued prompts was reached."
        case "needs_approval": return "The desktop needed an approval it can't take from a queued prompt."
        case "turn_failed": return "The desktop could not finish this prompt."
        case "project_unavailable": return "That project is not available on the desktop"
        case "refused": return "The desktop refused this prompt."
        default: return "The desktop could not answer (\(code))."
        }
    }

    private static var dir: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("sync", isDirectory: true)
    }
    private static func write<T: Encodable>(_ value: T, _ name: String) {
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var d = dir  // the queue holds prompt text and the cache the snapshot: keep both out of device and iCloud backups
        var v = URLResourceValues(); v.isExcludedFromBackup = true
        try? d.setResourceValues(v)
        guard let data = try? JSONEncoder().encode(value) else { return }
        try? data.write(to: dir.appendingPathComponent(name), options: [.atomic, .completeFileProtection])
    }
    private static func read<T: Decodable>(_ type: T.Type, _ name: String) -> T? {
        guard let data = try? Data(contentsOf: dir.appendingPathComponent(name)) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }

    enum Keychain {
        enum Item: String { case state = "device-state", keys = "device-keys", mega = "mega-session", box = "box-session", sourceConfig = "source-config", sourceTokens = "source-tokens" }
        private static func base(_ item: Item) -> [String: Any] {
            [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "com.llmide.sync", kSecAttrAccount as String: item.rawValue]
        }
        @discardableResult
        static func save<T: Encodable>(_ value: T, _ item: Item) -> Bool {
            delete(item)
            guard let data = try? JSONEncoder().encode(value) else { return false }
            var q = base(item)
            q[kSecValueData as String] = data
            q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            return SecItemAdd(q as CFDictionary, nil) == errSecSuccess
        }
        static func load<T: Decodable>(_ type: T.Type, _ item: Item) -> T? {
            var q = base(item)
            q[kSecReturnData as String] = true
            q[kSecMatchLimit as String] = kSecMatchLimitOne
            var out: AnyObject?
            guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
            return try? JSONDecoder().decode(type, from: data)
        }
        static func delete(_ item: Item) { SecItemDelete(base(item) as CFDictionary) }
    }
}
