import Testing
@testable import GlideCore

private func r(_ s: Int, _ e: Int) -> MatchRange { MatchRange(start: s, end: e) }

@Suite("fuzzyMatch — exact / prefix")
struct FuzzyExactPrefix {
    @Test func wholeTextEqualityIsExact() {
        let m = fuzzyMatch("Code", "code")!
        #expect(m.exact)
        #expect(m.score == EXACT_SCORE)
        #expect(m.ranges == [r(0, 4)])
    }
    @Test func prefixPerfectRun() {
        let m = fuzzyMatch("Code Editor", "cod")!
        #expect(!m.exact)
        #expect(m.prefix)
        #expect(m.score == 8)
        #expect(m.ranges == [r(0, 3)])
    }
    @Test func nullWhenMissing() {
        #expect(fuzzyMatch("Code", "codex") == nil)
        #expect(fuzzyMatch("Safari", "xyz") == nil)
        #expect(fuzzyMatch("ab", "abc") == nil)
    }
    @Test func emptyQueryNeverMatches() { #expect(fuzzyMatch("Code", "") == nil) }
}

@Suite("fuzzyMatch — boundary scoring")
struct FuzzyBoundaries {
    @Test func vscExample() {
        let m = fuzzyMatch("Visual Studio Code", "vsc")!
        #expect(m.score == 8)
        #expect(m.ranges == [r(0, 1), r(7, 8), r(14, 15)])
    }
    @Test func camelCase() {
        #expect(fuzzyMatch("iPhone", "ip")!.score == 7)
        #expect(fuzzyMatch("iphone", "ip")!.score == 6)
    }
    @Test func startOfText() {
        #expect(fuzzyMatch("abc", "a")!.score == 4)
        #expect(fuzzyMatch("xabc", "a")!.score == 2)
        #expect(fuzzyMatch("x abc", "a")!.score == 3)
    }
    @Test func gapsCostOne() {
        #expect(fuzzyMatch("cex", "ce")!.score == 6)
        #expect(fuzzyMatch("code", "ce")!.score == 5)
        #expect(fuzzyMatch("cxxxxxxe", "ce")!.score == 5)
    }
    @Test func bestPath() {
        let m = fuzzyMatch("Visual Studio", "st")!
        #expect(m.score == 5)
        #expect(m.ranges == [r(7, 9)])
    }
}

@Suite("fuzzyMatch — separators")
struct FuzzySeparators {
    @Test func separatorToSeparator() {
        let m = fuzzyMatch("Visual Studio", "visual-studio")!
        #expect(m.score == 28)
        #expect(m.skipped == 0)
        #expect(m.ranges == [r(0, 13)])
    }
    @Test func skippedSeparator() {
        let m = fuzzyMatch("VisualStudio", "visual/studio")!
        #expect(m.score == 27)
        #expect(m.skipped == 1)
    }
    @Test func literalDots() {
        #expect(fuzzyMatch("github.com", "github.com")!.exact)
        #expect(fuzzyMatch("githubcom", "github.com") == nil)
        #expect(fuzzyMatch("githubcom", "github.com", literalQueryDots: false)!.skipped == 1)
    }
    @Test func onlySeparators() { #expect(fuzzyMatch("abc", "-") == nil) }
}

@Suite("fuzzyMatch — diacritics")
struct FuzzyDiacritics {
    @Test func cafe() {
        let m = fuzzyMatch("Café", "cafe")!
        #expect(m.exact)
        #expect(m.ranges == [r(0, 4)])
        #expect(fuzzyMatch("Café Bar", "cafe")!.prefix)
        #expect(fuzzyMatch("Café", "café")!.exact)
    }
    @Test func foldPreservesLength() {
        let decomposed = "Cafe\u{301}"
        #expect(foldText(decomposed).utf16.count == decomposed.utf16.count)
        #expect(foldText("Ünïcödé") == "unicode")
    }
}

@Suite("passesSensitivity")
struct Sensitivities {
    @Test func low() { #expect(passesSensitivity(1, 10, 0, .low)) }
    @Test func medium() {
        #expect(passesSensitivity(5.5, 3, 0, .medium))
        #expect(!passesSensitivity(5.4, 3, 0, .medium))
        #expect(passesSensitivity(5.5, 4, 1, .medium))
    }
    @Test func high() {
        #expect(!passesSensitivity(6, 3, 0, .high))
        #expect(passesSensitivity(6.5, 3, 0, .high))
        #expect(!passesSensitivity(6, 4, 1, .high))
        #expect(passesSensitivity(7, 4, 1, .high))
    }
    @Test func exactAndUnmatched() {
        #expect(passesSensitivity(EXACT_SCORE, 100, 0, .high))
        #expect(!passesSensitivity(UNMATCHED_SCORE, 1, 0, .low))
    }
    @Test func vscPassesWeakDoesNot() {
        let vsc = fuzzyMatch("Visual Studio Code", "vsc")!
        #expect(passesSensitivity(vsc.score, 3, vsc.skipped, .high))
        let weak = fuzzyMatch("xavxbxc", "abc")!
        #expect(!passesSensitivity(weak.score, 3, weak.skipped, .high))
        #expect(passesSensitivity(weak.score, 3, weak.skipped, .low))
    }
}

@Suite("whole-word floor")
struct WholeWord {
    @Test func floorValue() { #expect(wholeWordFloor(4) == 10.5) }
    @Test func bounds() {
        let q = foldUnits("code")
        #expect(containsWholeWord(prepareText("Visual Studio Code"), q))
        #expect(!containsWholeWord(prepareText("Xcode"), q))
        #expect(!containsWholeWord(prepareText("Codex"), q))
        #expect(containsWholeWord(prepareText("vsCode"), q))
        #expect(!containsWholeWord(prepareText("VSCode"), q))
    }
}
