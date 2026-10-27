// Feeds shell output into xterm and watches for a marker string in it. The marker
// callback runs from xterm's write callback, i.e. once the marker's batch has been
// parsed into the terminal, not when bytes merely arrive.
import type { Terminal } from "@xterm/xterm";

/** Tail kept between batches so a marker split across two batches is still found. */
export class OutputPump {
  bytes = 0;
  firstOutputAt: number | null = null;
  private readonly decoder = new TextDecoder("utf-8");
  private marker: string | null = null;
  private tail = "";
  private onMarker: ((at: number) => void) | null = null;

  constructor(private readonly term: Terminal) {}

  /** Arms the marker: `cb` runs once the batch containing it is written into xterm. */
  watch(marker: string, cb: (at: number) => void): void {
    this.marker = marker;
    this.tail = "";
    this.onMarker = cb;
  }

  push(data: Uint8Array): void {
    this.bytes += data.length;
    this.firstOutputAt ??= performance.now();
    let hit = false;
    if (this.marker !== null) {
      const joined = this.tail + this.decoder.decode(data, { stream: true });
      hit = joined.includes(this.marker);
      this.tail = joined.slice(-this.marker.length);
    }
    if (!hit) {
      this.term.write(data);
      return;
    }
    const cb = this.onMarker;
    this.marker = null;
    this.onMarker = null;
    this.term.write(data, () => cb?.(performance.now()));
  }
}
