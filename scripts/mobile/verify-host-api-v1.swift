#!/usr/bin/env swift
//
//  verify-host-api-v1.swift — manual loopback check of the Mac's Host API v1 development listener.
//
//  Prerequisites: a DEBUG Mac build started with the flag, Mobile Control started:
//    cd mac && LLMIDE_HOST_API_DEV=1 swift run LlmIdeMac      # then Settings → Mobile Control → Start
//  Run:
//    swift scripts/mobile/verify-host-api-v1.swift <PIN> [port]      # PIN from Settings → Mobile Control
//
//  Checks (exit 0 if all pass): [1] host.hello → response with hostKind "mac" and apiVersion 1;
//  [2] host.auth.pair with the PIN → a token; [3] chat.snapshot → a messages array; [4] host.ping;
//  [5] a wrong command before auth on a fresh socket → error auth_failed; [6] host.auth.revoke → revoked true.
import Foundation

let args = CommandLine.arguments
guard args.count >= 2 else { print("usage: verify-host-api-v1.swift <PIN> [port]"); exit(2) }
let pin = args[1]
let port = args.count >= 3 ? args[2] : "3016"
var failures = 0

func open() -> URLSessionWebSocketTask {
    let t = URLSession.shared.webSocketTask(with: URL(string: "ws://127.0.0.1:\(port)")!)
    t.resume(); return t
}

func call(_ t: URLSessionWebSocketTask, _ id: String, _ command: String, _ payload: String) async throws -> [String: Any] {
    try await t.send(.string(#"{"apiVersion":1,"id":"\#(id)","type":"request","command":"\#(command)","payload":\#(payload),"ts":\#(Int(Date().timeIntervalSince1970 * 1000))}"#))
    while true {
        guard case .string(let s) = try await t.receive(),
              let obj = try JSONSerialization.jsonObject(with: Data(s.utf8)) as? [String: Any] else { continue }
        if obj["replyTo"] as? String == id { return obj }
    }
}

func check(_ label: String, _ ok: Bool) { print(ok ? "✅ \(label)" : "❌ \(label)"); if !ok { failures += 1 } }

let hello = #"{"clientName":"verify-host-api-v1","clientVersion":"1","platform":"mac","apiVersions":[1]}"#
let t = open()
let h = try await call(t, "c-1", "host.hello", hello)
check("[1] host.hello", (h["result"] as? [String: Any])?["hostKind"] as? String == "mac")
let p = try await call(t, "c-2", "host.auth.pair", #"{"pin":"\#(pin)"}"#)
let token = (p["result"] as? [String: Any])?["token"] as? String
check("[2] host.auth.pair → token", token != nil)
let s = try await call(t, "c-3", "chat.snapshot", "{}")
check("[3] chat.snapshot", (s["result"] as? [String: Any])?["messages"] is [Any])
let ping = try await call(t, "c-4", "host.ping", "{}")
check("[4] host.ping", ping["type"] as? String == "response")
let fresh = open()
let refused = try await call(fresh, "c-5", "chat.snapshot", "{}")
check("[5] before hello → auth_failed", (refused["error"] as? [String: Any])?["code"] as? String == "auth_failed")
if let token {
    let r = try await call(t, "c-6", "host.auth.revoke", #"{"token":"\#(token)"}"#)
    check("[6] host.auth.revoke", (r["result"] as? [String: Any])?["revoked"] as? Bool == true)
}
exit(failures == 0 ? 0 : 1)
