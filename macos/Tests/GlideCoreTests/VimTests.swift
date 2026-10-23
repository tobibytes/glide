import Testing
@testable import GlideCore

private func ctx(enabled: Bool = true, mode: VimMode = .normal, queryEmpty: Bool = true, viewPushed: Bool = false, now: Double = 1000) -> VimContext {
    VimContext(enabled: enabled, mode: mode, queryEmpty: queryEmpty, viewPushed: viewPushed, now: now)
}
private func press(_ key: String, _ c: VimContext = ctx(), ctrl: Bool = false, meta: Bool = false, shift: Bool = false, alt: Bool = false, state: VimState = .initial) -> VimResult {
    Vim.key(state, VimKey(key, ctrl: ctrl, meta: meta, shift: shift, alt: alt), c)
}
private func seq(_ keys: [(String, Double)], _ c: VimContext = ctx()) -> VimResult {
    var state = VimState.initial
    var last: VimResult!
    for (k, now) in keys {
        var cc = c
        cc.now = now
        last = Vim.key(state, VimKey(k, shift: k.count == 1 && (k.first!.isUppercase || k == "{" || k == "}")), cc)
        state = last.state
    }
    return last
}
private func seq(_ keys: [String], _ c: VimContext = ctx()) -> VimResult { seq(keys.map { ($0, 1000) }, c) }

@Suite("vim — insert mode")
struct VimInsert {
    let ins = ctx(mode: .insert)
    @Test func arrowsAndCtrl() {
        #expect(press("ArrowDown", ins).command == .move(delta: 1))
        #expect(press("ArrowUp", ins).command == .move(delta: -1))
        for k in ["j", "n"] { #expect(press(k, ins, ctrl: true).command == .move(delta: 1)) }
        for k in ["k", "p"] { #expect(press(k, ins, ctrl: true).command == .move(delta: -1)) }
    }
    @Test func pages() {
        #expect(press("d", ins, ctrl: true).command == .halfPage(dir: 1, count: 1))
        #expect(press("u", ins, ctrl: true).command == .halfPage(dir: -1, count: 1))
        #expect(press("ArrowDown", ins, alt: true).command == .move(delta: 5))
        #expect(press("ArrowUp", ins, meta: true).command == .section(dir: -1, count: 1))
    }
    @Test func lettersType() {
        for k in ["j", "k", "g", "G", "x", "q", "/"] {
            let r = press(k, ins)
            #expect(r.command == nil)
            #expect(!r.consumed)
        }
    }
    @Test func enterVariants() {
        #expect(press("Enter", ins).command == .activate([]))
        #expect(press("Enter", ins, shift: true).command == .activate(.shift))
        #expect(press("Enter", ins, meta: true).command == .secondary)
        #expect(press("k", ins, meta: true).command == .actions)
    }
    @Test func escVimOn() {
        #expect(press("Escape", ctx(mode: .insert, queryEmpty: false)).command == .normal)
        #expect(press("Escape", ctx(mode: .insert, viewPushed: true)).command == .normal)
        #expect(press("Escape", ins).command == .hide)
    }
    @Test func escVimOff() {
        #expect(press("Escape", ctx(enabled: false, mode: .insert, queryEmpty: false, viewPushed: true)).command == .clearQuery)
        #expect(press("Escape", ctx(enabled: false, mode: .insert, viewPushed: true)).command == .pop)
        #expect(press("Escape", ctx(enabled: false, mode: .insert)).command == .hide)
    }
    @Test func vimOffIgnoresNormal() { #expect(press("j", ctx(enabled: false, mode: .normal)).command == nil) }
    @Test func backspacePops() {
        #expect(press("Backspace", ctx(mode: .insert, viewPushed: true)).command == .pop)
        #expect(press("Backspace", ctx(mode: .insert, queryEmpty: false, viewPushed: true)).command == nil)
        #expect(press("Backspace", ins).command == nil)
    }
}

@Suite("vim — normal mode")
struct VimNormal {
    @Test func jk() {
        #expect(press("j").command == .move(delta: 1))
        #expect(press("k").command == .move(delta: -1))
        #expect(press("ArrowDown").command == .move(delta: 1))
        #expect(press("j", ctrl: true).command == .move(delta: 1))
    }
    @Test func counts() {
        #expect(seq(["5", "j"]).command == .move(delta: 5))
        #expect(seq(["1", "2", "k"]).command == .move(delta: -12))
        #expect(seq(["3", "}"]).command == .section(dir: 1, count: 3))
        #expect(seq(["2", "d"]).command == nil)
    }
    @Test func countState() {
        let r = press("4")
        #expect(r.consumed)
        #expect(r.command == nil)
        #expect(r.state.count == "4")
        #expect(press("0").state.count == "")
        #expect(seq(["1", "0", "j"]).command == .move(delta: 10))
        #expect(seq(["5", "j"]).state == .initial)
    }
    @Test func ctrlDWithCount() {
        let s = seq(["2"]).state
        #expect(Vim.key(s, VimKey("d", ctrl: true), ctx()).command == .halfPage(dir: 1, count: 2))
        #expect(press("u", ctrl: true).command == .halfPage(dir: -1, count: 1))
    }
    @Test func gg() {
        #expect(seq([("g", 1000), ("g", 1000 + Vim.ggWindowMs)]).command == .goto(.index(0)))
        let slow = seq([("g", 1000), ("g", 1000 + Vim.ggWindowMs + 1)])
        #expect(slow.command == nil)
        #expect(slow.state.gAt == 1000 + Vim.ggWindowMs + 1)
        #expect(seq([("g", 1000), ("g", 1601), ("g", 1700)]).command == .goto(.index(0)))
        #expect(seq(["g", "j", "g"]).command == nil)
    }
    @Test func bigG() {
        #expect(seq(["G"]).command == .goto(.last))
        #expect(seq(["3", "G"]).command == .goto(.index(2)))
        #expect(seq(["4", "g", "g"]).command == .goto(.index(3)))
    }
    @Test func shiftKeepsCount() {
        let s = press("5").state
        #expect(Vim.key(s, VimKey("Shift", shift: true), ctx()).state.count == "5")
    }
    @Test func sectionsPrimarySecondary() {
        #expect(seq(["}"]).command == .section(dir: 1, count: 1))
        #expect(seq(["{"]).command == .section(dir: -1, count: 1))
        #expect(press("l").command == .activate([]))
        #expect(press("o").command == .activate([]))
        #expect(press("Enter").command == .activate([]))
        #expect(press("O", shift: true).command == .secondary)
        #expect(press("Enter", meta: true).command == .secondary)
    }
    @Test func hAndBackspace() {
        #expect(press("h", ctx(viewPushed: true)).command == .pop)
        #expect(press("Backspace", ctx(viewPushed: true)).command == .pop)
        #expect(press("h").command == .clearQuery)
        #expect(press("Backspace", ctx(queryEmpty: false)).command == .clearQuery)
    }
    @Test func xyp() {
        #expect(press("x").command == .delete)
        #expect(press("y").command == .copy)
        #expect(press("p").command == .paste)
    }
    @Test func insertKeys() {
        #expect(press("i").command == .insert(clear: false))
        #expect(press("a").command == .insert(clear: false))
        #expect(press("/").command == .insert(clear: true))
        #expect(press(".").command == .actions)
        #expect(press("k", meta: true).command == .actions)
    }
    @Test func hide() {
        #expect(press("q").command == .hide)
        #expect(press("Escape", ctx(queryEmpty: false, viewPushed: true)).command == .hide)
    }
    @Test func swallowAndPassThrough() {
        let z = press("z")
        #expect(z.command == nil && z.consumed)
        #expect(!press("c", meta: true).consumed)
        #expect(!press("Tab").consumed)
    }
}

@Suite("vim — panel, nav, modes")
struct VimMisc {
    @Test func panel() {
        #expect(Vim.panelKey(VimKey("j")) == .move(1))
        #expect(Vim.panelKey(VimKey("k")) == .move(-1))
        #expect(Vim.panelKey(VimKey("l")) == .run)
        #expect(Vim.panelKey(VimKey("Enter")) == .run)
        #expect(Vim.panelKey(VimKey("h")) == .close)
        #expect(Vim.panelKey(VimKey("Escape")) == .close)
        #expect(Vim.panelKey(VimKey("k", meta: true)) == .close)
        #expect(Vim.panelKey(VimKey("/")) == .filter)
        #expect(Vim.panelKey(VimKey("z")) == nil)
    }
    @Test func applyNav() {
        let shape = Vim.NavShape(length: 6, sections: ["a", "a", "a", "b", "b", "c"], halfPage: 2)
        #expect(Vim.applyNav(.move(delta: 1), index: 0, shape: shape) == 1)
        #expect(Vim.applyNav(.move(delta: 10), index: 0, shape: shape) == 5)
        #expect(Vim.applyNav(.move(delta: -3), index: 1, shape: shape) == 0)
        #expect(Vim.applyNav(.move(delta: 1), index: 0, shape: .init(length: 0)) == -1)
        #expect(Vim.applyNav(.goto(.last), index: 0, shape: shape) == 5)
        #expect(Vim.applyNav(.goto(.index(0)), index: 4, shape: shape) == 0)
        #expect(Vim.applyNav(.goto(.index(99)), index: 0, shape: shape) == 5)
        #expect(Vim.applyNav(.halfPage(dir: 1, count: 1), index: 0, shape: shape) == 2)
        #expect(Vim.applyNav(.halfPage(dir: -1, count: 2), index: 5, shape: shape) == 1)
        #expect(Vim.applyNav(.section(dir: 1, count: 1), index: 0, shape: shape) == 3)
        #expect(Vim.applyNav(.section(dir: 1, count: 2), index: 0, shape: shape) == 5)
        #expect(Vim.applyNav(.section(dir: 1, count: 1), index: 5, shape: shape) == 5)
        #expect(Vim.applyNav(.section(dir: -1, count: 1), index: 4, shape: shape) == 3)
        #expect(Vim.applyNav(.section(dir: -1, count: 1), index: 3, shape: shape) == 0)
        #expect(Vim.applyNav(.section(dir: -1, count: 1), index: 0, shape: shape) == 0)
        #expect(Vim.applyNav(.section(dir: 1, count: 1), index: 0, shape: .init(length: 4)) == 3)
    }
    @Test func findAction() {
        let actions = [ItemAction(id: "o", title: "Open"), ItemAction(id: "c", title: "Copy Path"), ItemAction(id: "p", title: "Paste to App"),
                       ItemAction(id: "r", title: "Remove from History"), ItemAction(id: "d", title: "Delete All", destructive: true)]
        #expect(Vim.findAction(actions, kind: "copy")?.title == "Copy Path")
        #expect(Vim.findAction(actions, kind: "paste")?.title == "Paste to App")
        #expect(Vim.findAction(actions, kind: "delete")?.title == "Delete All")
        #expect(Vim.findAction([ItemAction(id: "r", title: "Remove")], kind: "delete")?.title == "Remove")
        #expect(Vim.findAction([ItemAction(id: "o", title: "Open")], kind: "copy") == nil)
    }

    /// vim-modes.test.ts: drive vimKey + modeAfter + a push/pop stack.
    private func simulate(_ keys: [String], mode: VimMode = .insert, depth: Int = 0, query: String = "") -> (mode: VimMode, depth: Int, query: String) {
        var mode = mode, depth = depth, query = query
        var state = VimState.initial
        for key in keys {
            let r = Vim.key(state, VimKey(key), ctx(mode: mode, queryEmpty: query.isEmpty, viewPushed: depth > 0))
            state = r.state
            if r.command == .pop {
                depth = max(0, depth - 1)
                mode = Vim.modeAfter(mode, .pop)
            } else if let c = r.command {
                mode = Vim.modeAfter(mode, .command(c))
            } else if mode == .insert && key.count == 1 {
                query += key
            }
        }
        return (mode, depth, query)
    }
    @Test func modeTransitions() {
        let a = simulate(["Escape", "h"], depth: 1)
        #expect(a.depth == 0 && a.mode == .insert)
        let b = simulate(["Escape", "Backspace"], depth: 2)
        #expect(b.depth == 1 && b.mode == .insert)
        let c = simulate(["Backspace"], depth: 1)
        #expect(c.depth == 0 && c.mode == .insert)
        #expect(simulate(["Escape", "h", "s", "a"], depth: 1).query == "sa")
        #expect(simulate(["Escape"], query: "x").mode == .normal)
        #expect(simulate(["Escape", "i"], query: "x").mode == .insert)
        #expect(simulate(["Escape", "/"], query: "x").mode == .insert)
        #expect(simulate(["Escape", "j", "k", "G", "g", "g", "3", "j"], query: "x").mode == .normal)
        #expect(Vim.modeAfter(.normal, .push) == .insert)
        #expect(Vim.modeAfter(.normal, .show) == .insert)
        #expect(Vim.modeAfter(.normal, .needsInput) == .insert)
        #expect(Vim.modeAfter(.insert, .command(.normal)) == .normal)
    }
}
