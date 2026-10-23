import Foundation
import Testing
@testable import GlideCore

private let DAY: Double = 86_400
private let HL = Frecency.defaultHalfLifeSec

private func close(_ a: Double, _ b: Double, _ digits: Int = 6) -> Bool { abs(a - b) < pow(10, Double(-digits)) / 2 }

@Suite("decode / visit")
struct DecodeVisit {
    @Test func neverVisited() {
        #expect(Frecency.decode(nil, 1_000_000) == 1)
        #expect(Frecency.decode(.nan, 1_000_000) == 1)
    }
    @Test func freshVisit() {
        let now = 1_700_000_000.0
        #expect(close(Frecency.decode(Frecency.visit(nil, now), now), 101))
    }
    @Test func decays() {
        let now = 1_700_000_000.0
        let d = Frecency.visit(nil, now)
        #expect(close(Frecency.decode(d, now + HL), 50.5))
        #expect(close(Frecency.decode(d, now + 2 * HL), 25.25))
        #expect(Frecency.decode(d, now + 100 * HL) == 1)
    }
    @Test func accumulates() {
        let now = 1_700_000_000.0
        var d = Frecency.visit(nil, now)
        d = Frecency.visit(d, now)
        #expect(close(Frecency.decode(d, now), 201))
        d = Frecency.visit(d, now + HL)
        #expect(close(Frecency.decode(d, now + HL), 200.5))
    }
    @Test func staleDate() {
        let now = 1_700_000_000.0
        #expect(close(Frecency.decode(Frecency.visit(now - 50 * DAY, now), now), 101))
    }
    @Test func customHalfLife() {
        let hl = 5 * DAY
        #expect(close(Frecency.decode(Frecency.visit(nil, 0, hl), hl, hl), 50.5))
    }
    @Test func decayScore() {
        #expect(close(Frecency.decayScore(101, sampledAtMs: 0, nowMs: HL * 1000), 50.5))
        #expect(Frecency.decayScore(101, sampledAtMs: 1000, nowMs: 0) == 101)
        #expect(Frecency.decayScore(1.2, sampledAtMs: 0, nowMs: HL * 1000 * 10) == 1)
    }
}

@Suite("dateFromRecord")
struct DateFromRecord {
    @Test func foldsLaunches() {
        let t0 = 1_700_000_000_000.0
        let rec = UsageRecord(itemId: "a", launches: [t0 + 1000, t0], count: 2, lastLaunchedAt: t0 + 1000)
        #expect(close(Frecency.decode(Frecency.dateFromRecord(rec)!, (t0 + 1000) / 1000), 201, 3))
    }
    @Test func beyondRing() {
        let t0 = 1_700_000_000_000.0
        let rec = UsageRecord(itemId: "a", launches: [t0], count: 3, lastLaunchedAt: t0)
        #expect(close(Frecency.decode(Frecency.dateFromRecord(rec)!, t0 / 1000), 301, 3))
    }
    @Test func empty() { #expect(Frecency.dateFromRecord(UsageRecord(itemId: "a", launches: [], count: 0, lastLaunchedAt: 0)) == nil) }
}

@Suite("FrecencyCache + stored search terms")
struct CacheTerms {
    @Test func recordsTerms() {
        var cache = FrecencyCache()
        let now = 1_700_000_000_000.0
        var rec = cache.recordVisit(nil, itemId: "x", nowMs: now, searchTerm: "Visual")
        rec = cache.recordVisit(rec, itemId: "x", nowMs: now + 1, searchTerm: "VS Code")
        rec = cache.recordVisit(rec, itemId: "x", nowMs: now + 2, searchTerm: "visual")
        rec = cache.recordVisit(rec, itemId: "x", nowMs: now + 3, searchTerm: "code")
        #expect(rec.count == 4)
        #expect(rec.launches.count == 4)
        #expect(rec.searchTerms == ["code", "visual", "vs code"])
        #expect(close(cache.score("x", nowMs: now + 3), 401, 3))
    }
    @Test func window17Days() {
        var cache = FrecencyCache()
        let now = 1_700_000_000_000.0
        _ = cache.recordVisit(nil, itemId: "x", nowMs: now, searchTerm: "note")
        #expect(cache.termsEligible("x", nowMs: now + Frecency.searchTermWindowMs - 1) == ["note"])
        #expect(cache.termsEligible("x", nowMs: now + Frecency.searchTermWindowMs + 1) == [])
    }
    @Test func requiresFrecencyAboveOne() {
        var cache = FrecencyCache()
        let now = 1_700_000_000_000.0
        var rec = cache.recordVisit(nil, itemId: "x", nowMs: now, searchTerm: "note")
        rec.launches = [now - 400 * DAY * 1000]
        rec.lastLaunchedAt = now - 1000
        cache.load([rec], nowMs: now)
        #expect(cache.score("x", nowMs: now) == 1)
        #expect(cache.termsEligible("x", nowMs: now) == [])
    }
    @Test func loadRestoresTerms() {
        var cache = FrecencyCache()
        let now = 1_700_000_000_000.0
        let rec = cache.recordVisit(nil, itemId: "x", nowMs: now, searchTerm: "Slack")
        var fresh = FrecencyCache()
        fresh.load([rec], nowMs: now + 1000)
        #expect(fresh.termsEligible("x", nowMs: now + 1000) == ["slack"])
        #expect(close(fresh.score("x", nowMs: now + 1000), 101, 2))
    }
}

@Suite("matchSearchTerms")
struct TermMatch {
    @Test func ordering() {
        #expect(matchSearchTerms(["slack"], "slack") == .exact)
        #expect(matchSearchTerms(["slack"], "sla") == .prefix)
        #expect(matchSearchTerms(["sla"], "slack") == .overbounds(count: 3))
        #expect(matchSearchTerms(["s"], "slack") == .unmatched)
        #expect(matchSearchTerms(["sl", "sla"], "slack") == .overbounds(count: 3))
        #expect(matchSearchTerms(["slack", "sla"], "sla") == .exact)
    }
}
