import { GoogleError } from "../sources/google/google-core.ts";
import type { IcalApi, IcalStatus, IcalSync } from "../sources/google/ical-api.ts";

/** In-memory iCal connector: the shape the core's `/kb/calendar-ical/*` routes will have. */
export class FakeIcal implements IcalApi {
  state: IcalStatus = { connected: false, calendarIdPrefix: "", lastSyncAt: null, events: 0, lastError: null };
  missing = false;
  urls: string[] = [];
  syncs: IcalSync[] = [{ events: 12, removed: 1, pending: false }];
  private gate(): void {
    if (this.missing) throw new GoogleError("core_update", null);
  }
  async status(): Promise<IcalStatus> {
    this.gate();
    return { ...this.state };
  }
  async connect(url: string): Promise<{ calendarIdPrefix: string }> {
    this.gate();
    this.urls.push(url);
    this.state = { ...this.state, connected: true, calendarIdPrefix: "me@e…".slice(0, 4) + "…" };
    return { calendarIdPrefix: "me@e…" };
  }
  async sync(): Promise<IcalSync> {
    this.gate();
    const r = this.syncs.shift() ?? { events: 0, removed: 0, pending: false };
    this.state = { ...this.state, lastSyncAt: "2026-10-31T00:00:00.000Z", events: this.state.events + r.events };
    return r;
  }
  async disconnect(): Promise<void> {
    this.gate();
    this.state = { connected: false, calendarIdPrefix: "", lastSyncAt: null, events: 0, lastError: null };
  }
}
