import { describe, expect, it } from "vitest";
import { createMiniReact, type HostNode } from "./react";

/* eslint-disable @typescript-eslint/no-explicit-any */

function setup() {
  const mr = createMiniReact();
  const R = mr.React as any;
  const h = R.createElement;
  const Box = mr.host("Box", ["extra"]);
  const commits: HostNode[][] = [];
  const errors: unknown[] = [];
  const root = mr.createRoot({ onCommit: () => commits.push(root.tree()), onError: (e) => errors.push(e) });
  const tick = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
    mr.flush();
  };
  return { mr, R, h, Box, root, commits, errors, tick };
}

const titles = (nodes: HostNode[]): unknown[] => nodes.map((n) => (n.type === "#text" ? n.text : [n.props.title, titles(n.children)]));

describe("mini React runtime", () => {
  it("renders host trees with props, text and slots", async () => {
    const { h, Box, root, tick } = setup();
    root.render(h(Box, { title: "a", extra: h(Box, { title: "slot" }) }, h(Box, { title: "b" }), "txt", null, false, 3));
    await tick();
    const tree = root.tree();
    expect(tree).toHaveLength(1);
    expect(tree[0].props).toEqual({ title: "a" });
    expect(titles(tree[0].children)).toEqual([["b", []], "txt", "3"]);
    expect(tree[0].slots.extra[0].props.title).toBe("slot");
  });

  it("supports useState updates batched into one commit and stable uids", async () => {
    const { h, R, Box, root, commits, tick } = setup();
    let set: (n: number) => void = () => undefined;
    function Counter() {
      const [n, setN] = R.useState(0);
      set = setN;
      return h(Box, { title: `n=${n}` });
    }
    root.render(h(Counter));
    await tick();
    const uid = root.tree()[0].uid;
    const before = commits.length;
    set(1);
    set(2);
    await tick();
    expect(commits.length).toBe(before + 1);
    expect(root.tree()[0].props.title).toBe("n=2");
    expect(root.tree()[0].uid).toBe(uid);
  });

  it("runs effects child-first, cleans up on dep change and unmount", async () => {
    const { h, R, Box, root, tick } = setup();
    const log: string[] = [];
    function Child({ v }: { v: number }) {
      R.useEffect(() => {
        log.push(`child+${v}`);
        return () => log.push(`child-${v}`);
      }, [v]);
      return h(Box, { title: "c" });
    }
    function Parent({ v, show }: { v: number; show: boolean }) {
      R.useEffect(() => {
        log.push("parent+");
        return () => log.push("parent-");
      }, []);
      R.useLayoutEffect(() => void log.push("layout"));
      return show ? h(Child, { v }) : null;
    }
    root.render(h(Parent, { v: 1, show: true }));
    await tick();
    expect(log).toEqual(["layout", "child+1", "parent+"]);
    log.length = 0;
    root.render(h(Parent, { v: 2, show: true }));
    await tick();
    expect(log).toEqual(["layout", "child-1", "child+2"]);
    log.length = 0;
    root.render(h(Parent, { v: 2, show: false }));
    await tick();
    expect(log).toEqual(["child-2", "layout"]);
    log.length = 0;
    root.unmount();
    expect(log).toEqual(["parent-"]);
  });

  it("keeps state by key when items reorder", async () => {
    const { h, R, Box, root, tick } = setup();
    const sets: Record<string, (s: string) => void> = {};
    function Item({ id }: { id: string }) {
      const [label, setLabel] = R.useState(id);
      sets[id] = setLabel;
      return h(Box, { title: label });
    }
    root.render(h(Box, null, ["a", "b", "c"].map((id) => h(Item, { key: id, id }))));
    await tick();
    sets.b("B!");
    await tick();
    root.render(h(Box, null, ["c", "b", "a"].map((id) => h(Item, { key: id, id }))));
    await tick();
    expect(root.tree()[0].children.map((n) => n.props.title)).toEqual(["c", "B!", "a"]);
  });

  it("propagates context through memo boundaries", async () => {
    const { h, R, Box, root, tick } = setup();
    const Ctx = R.createContext("default");
    let renders = 0;
    const Leaf = R.memo(function Leaf() {
      renders++;
      return h(Box, { title: R.useContext(Ctx) });
    });
    const Mid = R.memo(() => h(Leaf));
    let setV: (s: string) => void = () => undefined;
    function App() {
      const [v, set] = R.useState("one");
      setV = set;
      return h(Ctx.Provider, { value: v }, h(Mid));
    }
    root.render(h(R.Fragment, null, h(App), h(Leaf)));
    await tick();
    expect(root.tree().map((n) => n.props.title)).toEqual(["one", "default"]);
    const r0 = renders;
    setV("two");
    await tick();
    expect(root.tree().map((n) => n.props.title)).toEqual(["two", "default"]);
    expect(renders).toBe(r0 + 1);
  });

  it("supports useReducer, useMemo, useCallback, useRef, refs to host handles and forwardRef", async () => {
    const mr = createMiniReact();
    const R = mr.React as any;
    const h = R.createElement;
    const Field = mr.host("Field", [], () => ({ focus: () => "focused" }));
    const root = mr.createRoot({ onCommit: () => undefined, onError: (e) => { throw e; } });
    let dispatch: (a: string) => void = () => undefined;
    let ref: { current: any } = { current: null };
    const Fwd = R.forwardRef((p: { title: string }, r: unknown) => h(Field, { title: p.title, ref: r }));
    function App() {
      const [s, d] = R.useReducer((st: number, a: string) => (a === "inc" ? st + 1 : st), 10);
      dispatch = d;
      const doubled = R.useMemo(() => s * 2, [s]);
      ref = R.useRef(null);
      return h(Fwd, { title: String(doubled), ref });
    }
    root.render(h(App));
    for (let i = 0; i < 3; i++) await Promise.resolve();
    mr.flush();
    expect(root.tree()[0].props.title).toBe("20");
    expect(ref.current.focus()).toBe("focused");
    dispatch("inc");
    mr.flush();
    expect(root.tree()[0].props.title).toBe("22");
  });

  it("catches render errors in class error boundaries and reports uncaught ones", async () => {
    const { h, R, Box, root, errors, tick } = setup();
    class Boundary extends R.Component {
      state = { failed: false };
      static getDerivedStateFromError() {
        return { failed: true };
      }
      render() {
        return this.state.failed ? h(Box, { title: "fallback" }) : this.props.children;
      }
    }
    function Bad(): never {
      throw new Error("boom");
    }
    root.render(h(Boundary, null, h(Bad)));
    await tick();
    expect(root.tree()[0].props.title).toBe("fallback");
    root.render(h(Bad));
    await tick();
    expect(String(errors[0])).toMatch(/boom/);
  });

  it("supports Children helpers, cloneElement and jsx runtime keys", () => {
    const { R, mr } = setup();
    const kids = R.Children.toArray([R.createElement("a", { key: "x" }), [R.createElement("b")], null]);
    expect(kids).toHaveLength(2);
    expect(R.Children.count([1, [2, 3], null])).toBe(3);
    const el = mr.jsxRuntime.jsx("div", { title: "t", children: "c" }, "k1");
    expect(el.key).toBe("k1");
    expect(R.cloneElement(el, { title: "u" }).props).toEqual({ title: "u", children: "c" });
    expect(R.isValidElement(el)).toBe(true);
  });

  it("suspends with use() and shows the fallback until the promise settles", async () => {
    const { h, R, Box, root, tick } = setup();
    let resolve: (v: string) => void = () => undefined;
    const p = new Promise<string>((r) => (resolve = r));
    function Data() {
      return h(Box, { title: R.use(p) });
    }
    root.render(h(R.Suspense, { fallback: h(Box, { title: "loading" }) }, h(Data)));
    await tick();
    await tick();
    expect(root.tree()[0].props.title).toBe("loading");
    resolve("ready");
    await tick();
    await tick();
    expect(root.tree()[0].props.title).toBe("ready");
  });
});
