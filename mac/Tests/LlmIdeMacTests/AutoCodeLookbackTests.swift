import Testing
import Foundation
@testable import LlmIdeMac

struct AutoCodeLookbackTests {
    @Test func cutoffIsDaysAgoInMilliseconds() {
        let now = Date(timeIntervalSince1970: 1_000_000)   // seconds
        let cutoff = AutoCodeUpdateService.lookbackCutoffMs(now: now, days: 7)
        // 7 days earlier, expressed in epoch milliseconds.
        #expect(cutoff == Int64((1_000_000 - 7 * 86_400) * 1000))
    }

    @Test func cutoffFloorsDaysAtOne() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        #expect(AutoCodeUpdateService.lookbackCutoffMs(now: now, days: 0)
                == AutoCodeUpdateService.lookbackCutoffMs(now: now, days: 1))
        #expect(AutoCodeUpdateService.lookbackCutoffMs(now: now, days: -5)
                == AutoCodeUpdateService.lookbackCutoffMs(now: now, days: 1))
    }

    @Test func aMeetingFromTwoDaysAgoIsInsideASevenDayWindow() {
        let now = Date(timeIntervalSince1970: 2_000_000)
        let cutoff = AutoCodeUpdateService.lookbackCutoffMs(now: now, days: 7)
        let twoDaysAgoMs = Int64((2_000_000 - 2 * 86_400) * 1000)
        let tenDaysAgoMs = Int64((2_000_000 - 10 * 86_400) * 1000)
        #expect(twoDaysAgoMs >= cutoff)    // in window
        #expect(tenDaysAgoMs < cutoff)     // out of window
    }
}
