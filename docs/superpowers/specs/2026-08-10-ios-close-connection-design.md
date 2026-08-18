# iOS "Close Connection" + Reconnect

## Problem

The iOS app has no way to close the live mobile-control link to the Mac
without also forgetting the paired device. The only two existing actions —
the toolbar "Disconnect" in `MobileHomeView` and "Forget this Mac" in
`SettingsView` — both call `connection.disconnect()` **and**
`connectionStore.clear()`, which wipes the saved IP/port/PIN. Closing the
link today therefore forces a full re-pair (QR scan or manual PIN entry)
next time, even though the Mac may still be running and reachable.

## Goal

Add a way to close the current session while keeping the saved pairing, so
the app can reconnect without asking the user to re-pair — either
automatically on next cold launch (already implemented) or on demand while
the app stays open.

## Non-goals

- No changes to the wire protocol (`SharedProtocol`) or the Mac-side
  `MobileWebSocketServer` — it already tears down cleanly on a client
  disconnect.
- No background auto-retry loop after an intentional close. Reconnecting
  only happens via the new "Reconnect" button or an app relaunch.
- "Forget this Mac" keeps its current full-wipe behavior unchanged.

## Design

### 1. `ConnectionService.swift` — new soft-close method

Add a public wrapper around the existing private `disconnect(clearDirect:)`:

```swift
/// Close the socket but keep the saved pairing (directIP/Port/PIN) so a
/// later `connectDirect` call — from the Reconnect button or the next
/// cold launch — can re-establish the link without re-pairing.
func closeConnection() { disconnect(clearDirect: false) }
```

This reuses all existing teardown logic (heartbeat cancel, reconnect-task
cancel, chat-store error handling) — the only difference from the existing
public `disconnect()` is that `directIP`/`directPort`/`directPIN` are left
set, and the caller must NOT also call `connectionStore.clear()`.

### 2. `MobileHomeView.swift` — toolbar menu

Menu becomes:

```
Settings
--------
Close Connection        <- NEW, non-destructive: connection.closeConnection()
Forget this Mac         <- renamed from "Disconnect", destructive, unchanged:
                            connection.disconnect() + connectionStore.clear()
```

### 3. `MobileHomeView.swift` — disconnected state

`disconnectedHint` gets a "Reconnect" button, shown when
`connection.connectionStatus == .disconnected` (not `.connecting`):

```swift
Button("Reconnect") {
    connection.connectDirect(
        ip: connectionStore.deviceIP,
        port: connectionStore.devicePort,
        pin: connectionStore.devicePIN
    )
}
```

Same call `ContentView.onAppear` already makes for cold-launch
auto-reconnect. Copy changes from "Pair again from the login screen if this
persists." to something reflecting that the pairing is still saved (e.g.
"Reconnect, or reopen the app once your Mac is back online.").

## Data flow

No new wire messages. Sequence for "Close Connection":

1. User taps Close Connection → `ConnectionService.closeConnection()`
2. WebSocket cancelled client-side; Mac's `MobileWebSocketServer` sees
   `.failed`/`.cancelled` on its `NWConnection` and calls
   `onClientDisconnected()` (existing path, no change).
3. `connectionStore` is untouched — `hasDevice` stays `true`.
4. Next `connectDirect` (Reconnect button or app relaunch) re-pairs using
   the same saved PIN; Mac treats it as a new connection (single-client
   replace policy, existing behavior).

## Testing

No iOS UI test harness exists in this project (manual verification only,
per existing project convention). Verification plan:

- Build and run the iOS app paired to a running Mac.
- Tap Close Connection → socket closes, Settings still shows the saved Mac
  (IP/PIN not cleared).
- Tap Reconnect on the disconnected screen → link re-establishes without
  re-entering the PIN.
- Force-quit and relaunch the app → auto-reconnects via `ContentView`'s
  existing `hasDevice` check, no manual action needed.
- Tap "Forget this Mac" → confirm it still fully clears the saved
  connection (regression check on unchanged behavior).
