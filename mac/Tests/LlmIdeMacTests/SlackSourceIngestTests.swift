import Testing
import Foundation
@testable import LlmIdeMac

/// Exercises `SlackSource`'s per-channel ingest loop through its injectable
/// seams — no live Slack, no filesystem, no summarization. The regression under
/// test: a single failing channel must NOT abort the whole run (was `break`,
/// now `continue`), so every configured channel is still fetched.
@MainActor
struct SlackSourceIngestTests {

    private enum FakeError: Error, CustomStringConvertible {
        case kicked
        var description: String { "not_in_channel" }
    }

    /// Records what each injected seam was asked to do, in order.
    @MainActor private final class Recorder {
        var fetched: [String] = []
        var noted: [String] = []
        var seen: [(channel: String, ts: [String], lastTs: String?)] = []
    }

    private func msg(_ ts: String, _ ch: String) -> LlmIdeAPIClient.SlackMessage {
        .init(ts: ts, channelId: ch, user: "u", text: "hi", threadTs: nil)
    }
    private func fetchResult(_ msgs: [LlmIdeAPIClient.SlackMessage],
                             overCap: Int = 0) -> LlmIdeAPIClient.SlackFetchResult {
        .init(messages: msgs, skipped: .init(overCap: overCap))
    }

    @Test func continuesPastAFailedChannelAndFetchesTheRest() async {
        let rec = Recorder()
        let result = await SlackSource.ingest(
            channels: ["A", "B", "C"],
            lookbackDays: 7,
            fetch: { ch, _ in
                rec.fetched.append(ch)
                if ch == "A" { throw FakeError.kicked }   // bot kicked from A
                return self.fetchResult([self.msg("100.0", ch)])
            },
            writeNote: { ch, _ in rec.noted.append(ch) },
            markSeen: { ch, ts, last in rec.seen.append((ch, ts, last)) })

        // The bug: A failing first must NOT skip B and C.
        #expect(rec.fetched == ["A", "B", "C"])
        #expect(rec.noted == ["B", "C"])
        #expect(rec.seen.map(\.channel) == ["B", "C"])   // A never marked seen
        // Failure is surfaced, but the notes that landed are still reported so
        // the driver rescans (imported > 0).
        if case let .failure(message, imported) = result {
            #expect(message.contains("A"))
            #expect(imported == 2)
        } else {
            Issue.record("expected .failure, got \(result)")
        }
    }

    @Test func continuesPastANoteWriteFailure() async {
        let rec = Recorder()
        let result = await SlackSource.ingest(
            channels: ["A", "B"],
            lookbackDays: 7,
            fetch: { ch, _ in self.fetchResult([self.msg("1.0", ch)]) },
            writeNote: { ch, _ in
                rec.noted.append(ch)
                if ch == "A" { throw FakeError.kicked }
            },
            markSeen: { ch, ts, last in rec.seen.append((ch, ts, last)) })

        #expect(rec.noted == ["A", "B"])                 // both attempted
        #expect(rec.seen.map(\.channel) == ["B"])        // A not marked seen (note failed)
        if case let .failure(_, imported) = result {
            #expect(imported == 1)
        } else {
            Issue.record("expected .failure, got \(result)")
        }
    }

    @Test func advancesHighWaterOnlyWhenChannelIsFullyDrained() async {
        let rec = Recorder()
        _ = await SlackSource.ingest(
            channels: ["drained", "capped"],
            lookbackDays: 7,
            fetch: { ch, _ in
                self.fetchResult(
                    [self.msg("10.0", ch), self.msg("30.0", ch), self.msg("20.0", ch)],
                    overCap: ch == "capped" ? 5 : 0)
            },
            writeNote: { _, _ in },
            markSeen: { ch, ts, last in rec.seen.append((ch, ts, last)) })

        let drained = rec.seen.first { $0.channel == "drained" }
        let capped = rec.seen.first { $0.channel == "capped" }
        #expect(drained?.lastTs == "30.0")   // high-water = max ts when fully drained
        #expect(capped?.lastTs == nil)        // NOT advanced when messages were over the cap
    }

    @Test func reportsImportedWithMoreAvailableWhenAllChannelsSucceed() async {
        let result = await SlackSource.ingest(
            channels: ["A", "B"],
            lookbackDays: 7,
            fetch: { ch, _ in self.fetchResult([self.msg("1.0", ch)], overCap: ch == "A" ? 3 : 0) },
            writeNote: { _, _ in },
            markSeen: { _, _, _ in })

        if case let .imported(count, more, oversize) = result {
            #expect(count == 2)
            #expect(more == 3)      // overCap summed across channels
            #expect(oversize == 0)
        } else {
            Issue.record("expected .imported, got \(result)")
        }
    }
}
