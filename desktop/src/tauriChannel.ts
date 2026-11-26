// The one factory for a Tauri `Channel` the Rust host streams messages into. Every bridge used to write
// the same three lines (new Channel, set onmessage, check the shape).
import { Channel } from "@tauri-apps/api/core";

/**
 * A channel whose messages go through `decode` first; `onValue` receives what `decode` returns. `decode` returns
 * `undefined` to drop a message whose shape is wrong (the host is trusted, but the shape is still checked).
 */
export function createChannel<Wire, Value>(decode: (raw: Wire) => Value | undefined, onValue: (value: Value) => void): Channel<Wire> {
  const channel = new Channel<Wire>();
  channel.onmessage = (raw) => {
    const value = decode(raw);
    if (value !== undefined) onValue(value);
  };
  return channel;
}
