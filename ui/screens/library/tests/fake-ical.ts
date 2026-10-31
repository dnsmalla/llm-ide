import { IcalError, MAX_FEEDS, type AddedFeed, type Feed, type FeedOptions, type FeedSync, type IcalApi } from "../sources/google/ical-api.ts";

/** In-memory multi-feed iCal connector with the shape of the core's `/kb/calendar-ical/*` routes. */
export class FakeIcal implements IcalApi {
  feeds: Feed[] = [];
  missing = false;
  /** Every secret address received by `add` (the test asserts it is never found anywhere else). */
  urls: string[] = [];
  /** Queued sync answers; an `IcalError` entry is thrown. */
  syncs: (FeedSync | IcalError)[] = [];
  calls: string[] = [];
  private seq = 0;
  private gate(): void {
    if (this.missing) throw new IcalError("core_update", null);
  }
  async list(): Promise<Feed[]> {
    this.gate();
    return this.feeds.map((f) => ({ ...f, options: { ...f.options } }));
  }
  async add(name: string, url: string): Promise<AddedFeed> {
    this.gate();
    if (this.feeds.length >= MAX_FEEDS) throw new IcalError("too_many", "ICAL_TOO_MANY_SOURCES");
    if (this.urls.includes(url)) throw new IcalError("duplicate", "ICAL_DUPLICATE");
    this.urls.push(url);
    const sourceId = (++this.seq).toString(16).padStart(12, "0");
    this.feeds.push({ sourceId, name, calendarIdPrefix: "me@examp", host: "calendar.google.com", status: "idle", lastRunAt: null, lastError: null, options: { daysBack: 30, daysAhead: 90 } });
    return { sourceId, name, calendarIdPrefix: "me@examp", host: "calendar.google.com" };
  }
  async remove(sourceId: string): Promise<{ purgedSources: number }> {
    this.gate();
    this.calls.push(`remove:${sourceId}`);
    const before = this.feeds.length;
    this.feeds = this.feeds.filter((f) => f.sourceId !== sourceId);
    if (this.feeds.length === before) throw new IcalError("not_found", "ICAL_NOT_FOUND");
    return { purgedSources: 14 };
  }
  async sync(sourceId: string): Promise<FeedSync> {
    this.gate();
    this.calls.push(`sync:${sourceId}`);
    const r = this.syncs.shift() ?? { sourceId, status: "ok" as const, events: 6, instances: 12, cancelled: 3, removed: 1, truncated: false, warnings: [] };
    const f = this.feeds.find((x) => x.sourceId === sourceId);
    if (r instanceof IcalError) {
      if (f) Object.assign(f, { status: r.code === "revoked" ? "revoked" : "error", lastError: r.serverCode, lastRunAt: "2026-10-31T00:00:00.000Z" });
      throw r;
    }
    if (f) Object.assign(f, { status: "idle", lastError: null, lastRunAt: "2026-10-31T00:00:00.000Z" });
    return r;
  }
  async setOptions(sourceId: string, options: FeedOptions): Promise<FeedOptions> {
    this.gate();
    this.calls.push(`options:${sourceId}`);
    const f = this.feeds.find((x) => x.sourceId === sourceId);
    if (!f) throw new IcalError("not_found", "ICAL_NOT_FOUND");
    f.options = { ...options };
    return { ...options };
  }
}
