#!/usr/bin/env swift
//
//  verify-native-pairing.swift
//
//  Loopback check for the Phase 2 native Mac WebSocket server.
//
//  Prerequisites:
//    1. LLM IDE Mac app running.
//    2. Settings -> Mobile Control -> enable the toggle, then press "Start".
//       This starts the native server on 127.0.0.1:3006 and advertises
//       _llmide._tcp over Bonjour. The Settings panel shows the current
//       PIN, IP, port, and pairing QR.
//
//  Run:
//    swift scripts/mobile/verify-native-pairing.swift            # PIN from Keychain
//    swift scripts/mobile/verify-native-pairing.swift 123456     # PIN from CLI arg
//
//  What it checks (exit 0 if all pass, exit 1 otherwise):
//    [1] Pairing with the CORRECT PIN  -> {"type":"connected","deviceName":"..."}
//    [2] Heartbeat on the paired socket -> {"type":"heartbeat_ack","ts":...}
//    [3] Pairing with a WRONG PIN       -> {"type":"auth_failed",...} then close
//
//  The PIN is read from the macOS Keychain via:
//    security find-generic-password -s 'com.llmide.macapp' -a 'mobile::pin' -w
//  mirroring MobilePin.swift / KeychainStore.swift.
//
//  Foundation only; no external dependencies. macOS 10.15+.
//

import Foundation

let wsURL = "ws://127.0.0.1:3006/ws"
let keychainService = "com.llmide.macapp"
let keychainAccount = "mobile::pin"

// MARK: - PIN resolution

func readPinFromKeychain() -> String? {
    let p = Process()
    p.launchPath = "/usr/bin/security"
    p.arguments = ["find-generic-password", "-s", keychainService,
                   "-a", keychainAccount, "-w"]
    let pipe = Pipe(); p.standardOutput = pipe; p.standardError = Pipe()
    do { try p.run() } catch { return nil }
    p.waitUntilExit()
    guard p.terminationStatus == 0 else { return nil }
    let raw = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)
    return raw?.trimmingCharacters(in: .whitespacesAndNewlines)
}

let pin: String
if let arg = CommandLine.arguments.dropFirst().first, !arg.isEmpty {
    pin = arg
} else if let kc = readPinFromKeychain(), !kc.isEmpty {
    pin = kc
} else {
    FileHandle.standardError.write(Data("ERROR: could not read PIN; pass it as an argument.\n".utf8))
    exit(2)
}
print("Using PIN: \(pin)   server: \(wsURL)\n")

// MARK: - WebSocket helpers (semaphore-synchronous for script use)

func connect(_ urlString: String) -> URLSessionWebSocketTask? {
    guard let url = URL(string: urlString) else { return nil }
    let task = URLSession.shared.webSocketTask(with: url)
    task.resume()
    return task
}

func sendText(_ task: URLSessionWebSocketTask, _ text: String) {
    let sem = DispatchSemaphore(value: 0)
    task.send(.string(text)) { _ in sem.signal() }
    _ = sem.wait(timeout: .now() + 5)
}

func receiveText(_ task: URLSessionWebSocketTask) -> String? {
    let sem = DispatchSemaphore(value: 0)
    var got: String?
    task.receive { result in
        if case .success(let msg) = result {
            switch msg {
            case .string(let s): got = s
            case .data(let d): got = String(data: d, encoding: .utf8)
            @unknown default: break
            }
        }
        sem.signal()
    }
    _ = sem.wait(timeout: .now() + 5)
    return got
}

// MARK: - Checks
// The native server accepts ONE client at a time (a new connection replaces the
// previous one), so the heartbeat runs on the correct-PIN socket BEFORE we open
// the wrong-PIN connection.

var passes = 0
func expect(_ label: String, reply: String?, contains: String) {
    let ok = reply?.contains(contains) ?? false
    print("\(label): \(ok ? "PASS" : "FAIL")   reply=\(reply ?? "<none>")")
    if ok { passes += 1 }
}

// [1]+[2] correct PIN, then heartbeat, on one socket.
if let t = connect(wsURL) {
    sendText(t, "{\"type\":\"pairing\",\"pin\":\"\(pin)\"}")
    expect("[1] correct-PIN pairing", reply: receiveText(t),
           contains: "\"type\":\"connected\"")
    sendText(t, "{\"type\":\"heartbeat\"}")
    expect("[2] heartbeat", reply: receiveText(t),
           contains: "\"type\":\"heartbeat_ack\"")
    t.cancel(with: .goingAway, reason: nil)
} else {
    print("[1] FAIL: could not open WebSocket to \(wsURL) — is Mobile Control started?")
}

// [3] wrong PIN on a fresh socket.
if let t = connect(wsURL) {
    sendText(t, "{\"type\":\"pairing\",\"pin\":\"000000\"}")
    expect("[3] wrong-PIN pairing", reply: receiveText(t),
           contains: "\"type\":\"auth_failed\"")
    t.cancel(with: .goingAway, reason: nil)
}

print("\nResult: \(passes)/3 checks passed")
exit(passes == 3 ? 0 : 1)
