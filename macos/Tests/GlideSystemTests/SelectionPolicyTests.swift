import Foundation
import GlideCore
@testable import GlideSystem
import Testing

/// N4: pure parts of selection reading and paste-back (no Accessibility calls, no pasteboard).
@Suite("selection read policy + paste timing")
struct SelectionPolicyTests {
    @Test func backoffSchedule() {
        let p = SelectionReadPolicy.standard
        #expect(p.attempts == 4)
        #expect(p.delay(beforeAttempt: 0, afterWake: false) == 0)
        #expect(p.delay(beforeAttempt: 1, afterWake: false) == 0.08)
        #expect(p.delay(beforeAttempt: 1, afterWake: true) == 0.08 + 0.25)
        #expect(p.delay(beforeAttempt: 2, afterWake: true) == 0.2)
        // strictly increasing backoff, total well under the callers' 3 s timeout
        #expect(zip(p.backoff, p.backoff.dropFirst()).allSatisfy { $0 < $1 })
        #expect(p.totalDelay < 1.5)
    }

    @Test func wakesOnlyAfterTheFirstMiss() {
        let p = SelectionReadPolicy.standard
        #expect(p.shouldWake(attempt: 0, focusedFound: false))
        #expect(p.shouldWake(attempt: 0, focusedFound: true))
        #expect(!p.shouldWake(attempt: 1, focusedFound: false))
    }

    @Test func reasons() {
        #expect(SelectionReadPolicy.reason(focusedFound: false) == "no-focused-element")
        #expect(SelectionReadPolicy.reason(focusedFound: true) == "no-selected-text")
    }

    @Test func utf16RangeSlicing() {
        #expect(SelectionReadPolicy.substring("héllo 😀 world", location: 6, length: 2) == "😀")
        #expect(SelectionReadPolicy.substring("abc", location: 1, length: 5) == nil)
        #expect(SelectionReadPolicy.substring("abc", location: 0, length: 0) == nil)
    }

    @Test func pasteRestoreDelay() {
        #expect(PasteTiming.restoreDelay(bundleId: nil) == PasteTiming.standard)
        #expect(PasteTiming.restoreDelay(bundleId: "com.apple.TextEdit") == 0.3)
        #expect(PasteTiming.restoreDelay(bundleId: "com.google.Chrome") == PasteTiming.slow)
        #expect(PasteTiming.restoreDelay(bundleId: "com.tinyspeck.slackmacgap") == PasteTiming.slow)
    }

    @MainActor @Test func headlessSelectionFake() async {
        let s = HeadlessSelection(text: nil)
        #expect(await s.selectedText().reason == "no-selected-text")
        s.text = "picked"
        #expect(await s.selectedText().text == "picked")
    }
}
