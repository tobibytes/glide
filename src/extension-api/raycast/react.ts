/**
 * A small React-compatible component runtime for Raycast-style extensions.
 *
 * Glide has no `react-reconciler`, so extensions that `import React from "react"` get this
 * module instead (the extension process maps `react` and `react/jsx-runtime` here). It implements
 * the public React API that extensions use — elements/JSX, function and class components,
 * hooks, context, memo, forwardRef, Fragment, Suspense (basic) — and renders into a plain
 * "host tree" of named host components (List, List.Item, Action…), which the API layer turns
 * into JSON for the launcher.
 *
 * `createMiniReact` must stay self-contained (it is serialised with Function.prototype.toString
 * into the extension runner), so it references nothing outside its own body.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface HostNode {
  type: string;
  /** Stable for the lifetime of the mounted host instance. */
  uid: number;
  key: string | null;
  props: Record<string, any>;
  children: HostNode[];
  /** Element-valued props declared as slots (e.g. `actions`, `detail`), rendered as subtrees. */
  slots: Record<string, HostNode[]>;
  text?: string;
}

export interface MiniRoot {
  render(element: unknown): void;
  unmount(): void;
  /** The current host tree (top-level host nodes). */
  tree(): HostNode[];
}

export interface RootCallbacks {
  /** Called after a commit that changed this root. */
  onCommit(): void;
  /** An error no error boundary caught. */
  onError(error: unknown): void;
}

export interface MiniReact {
  React: Record<string, any>;
  jsxRuntime: Record<string, any>;
  createRoot(cb: RootCallbacks): MiniRoot;
  /** Declare a host component (rendered by Glide). `slots` are props whose element values are rendered as subtrees. */
  host(name: string, slots?: string[], handle?: () => Record<string, unknown>): any;
  /** Run all pending updates and effects now (tests). */
  flush(): void;
}

export function createMiniReact(): MiniReact {
  const ELEMENT = Symbol.for("react.transitional.element");
  const LEGACY_ELEMENT = Symbol.for("react.element");
  const FRAGMENT = Symbol.for("react.fragment");
  const PROVIDER = Symbol.for("react.provider");
  const CONTEXT = Symbol.for("react.context");
  const CONSUMER = Symbol.for("react.consumer");
  const MEMO = Symbol.for("react.memo");
  const FORWARD_REF = Symbol.for("react.forward_ref");
  const SUSPENSE = Symbol.for("react.suspense");
  const LAZY = Symbol.for("react.lazy");
  const STRICT = Symbol.for("react.strict_mode");
  const PROFILER = Symbol.for("react.profiler");
  const HOST = "$$glideHost";
  const SLOT_TYPE: any = { $$typeof: Symbol.for("glide.slot") };

  type Kind = "root" | "host" | "text" | "fn" | "class" | "fragment" | "provider" | "consumer" | "memo" | "forward" | "suspense" | "lazy" | "slot";

  interface Hook {
    tag: "state" | "effect" | "layout" | "memo" | "ref" | "id" | "store";
    state?: any;
    queue?: any[];
    reducer?: (s: any, a: any) => any;
    dispatch?: (a: any) => void;
    deps?: unknown[] | null;
    create?: (() => unknown) | null;
    cleanup?: (() => void) | void;
    value?: any;
  }

  interface Inst {
    uid: number;
    kind: Kind;
    type: any;
    key: string | null;
    element: any;
    props: any;
    parent: Inst | null;
    children: Inst[];
    hooks: Hook[];
    depth: number;
    root: RootState;
    dirty: boolean;
    mounted: boolean;
    ctxDeps?: Map<any, unknown>;
    classInst?: any;
    pendingState?: any[];
    text?: string;
    slot?: string;
    ref?: any;
    refCleanup?: (() => void) | void;
    handle?: any;
    suspended?: boolean;
    lazyValue?: any;
    errorCaught?: unknown;
    didMount?: boolean;
    prevPropsForUpdate?: any;
    prevStateForUpdate?: any;
  }

  interface RootState {
    inst: Inst;
    cb: RootCallbacks;
    changed: boolean;
    alive: boolean;
  }

  let uidSeq = 0;
  let current: Inst | null = null;
  let hookIndex = 0;
  let idSeq = 0;
  const dirty = new Set<Inst>();
  let scheduled = false;
  let flushing = false;
  let committed: Inst[] = [];
  let deletions: Inst[] = [];

  const is = Object.is;
  const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object";
  const isElement = (v: unknown): boolean => isObj(v) && (v.$$typeof === ELEMENT || v.$$typeof === LEGACY_ELEMENT);
  const depsChanged = (a: unknown[] | null | undefined, b: unknown[] | null | undefined) =>
    !a || !b || a.length !== b.length || a.some((v, i) => !is(v, b[i]));

  // --- elements ------------------------------------------------------------------------

  function makeElement(type: any, key: any, props: Record<string, any>) {
    if (type && type.defaultProps && typeof type === "function") {
      for (const k of Object.keys(type.defaultProps)) if (props[k] === undefined) props[k] = type.defaultProps[k];
    }
    return { $$typeof: ELEMENT, type, key: key === undefined || key === null ? null : String(key), ref: props.ref ?? null, props, _owner: null, _store: {} };
  }

  function createElement(type: any, config?: Record<string, any> | null, ...children: unknown[]) {
    const props: Record<string, any> = {};
    let key: any = null;
    if (config) {
      for (const k of Object.keys(config)) {
        if (k === "key") key = config.key;
        else if (k !== "__self" && k !== "__source") props[k] = config[k];
      }
    }
    if (children.length === 1) props.children = children[0];
    else if (children.length > 1) props.children = children;
    return makeElement(type, key, props);
  }

  function jsx(type: any, config: Record<string, any> | null, maybeKey?: unknown) {
    const props: Record<string, any> = {};
    let key: any = maybeKey;
    if (config) {
      for (const k of Object.keys(config)) {
        if (k === "key") key = config.key;
        else props[k] = config[k];
      }
    }
    return makeElement(type, key, props);
  }

  function cloneElement(el: any, config?: Record<string, any> | null, ...children: unknown[]) {
    const props: Record<string, any> = { ...el.props };
    let key = el.key;
    if (config) {
      for (const k of Object.keys(config)) {
        if (k === "key") key = config.key;
        else if (config[k] !== undefined || !(el.type && el.type.defaultProps && k in el.type.defaultProps)) props[k] = config[k];
      }
    }
    if (children.length === 1) props.children = children[0];
    else if (children.length > 1) props.children = children;
    return makeElement(el.type, key, props);
  }

  // --- Children helpers ------------------------------------------------------------------

  function flattenChildren(children: unknown, prefix: string, out: Array<{ node: unknown; key: string }>) {
    if (children === null || children === undefined || typeof children === "boolean") return;
    if (Array.isArray(children)) {
      children.forEach((c, i) => flattenChildren(c, `${prefix}${isElement(c) && (c as any).key !== null ? `$${(c as any).key}` : `.${i}`}:`, out));
      return;
    }
    if (isObj(children) && typeof (children as any)[Symbol.iterator] === "function" && !isElement(children)) {
      flattenChildren(Array.from(children as Iterable<unknown>), prefix, out);
      return;
    }
    out.push({ node: children, key: prefix });
  }

  const Children = {
    toArray(children: unknown) {
      const out: Array<{ node: unknown; key: string }> = [];
      flattenChildren(children, "", out);
      return out.map(({ node, key }) => (isElement(node) ? cloneElement(node, { key }) : node));
    },
    map(children: unknown, fn: (c: unknown, i: number) => unknown, thisArg?: unknown) {
      if (children === null || children === undefined) return children;
      const out: Array<{ node: unknown; key: string }> = [];
      flattenChildren(children, "", out);
      return out.map(({ node, key }, i) => {
        const r = fn.call(thisArg, node, i);
        return isElement(r) && (r as any).key === null ? cloneElement(r, { key }) : r;
      });
    },
    forEach(children: unknown, fn: (c: unknown, i: number) => void, thisArg?: unknown) {
      const out: Array<{ node: unknown; key: string }> = [];
      flattenChildren(children, "", out);
      out.forEach(({ node }, i) => fn.call(thisArg, node, i));
    },
    count(children: unknown) {
      const out: Array<{ node: unknown; key: string }> = [];
      flattenChildren(children, "", out);
      return out.length;
    },
    only(children: unknown) {
      if (!isElement(children)) throw new Error("React.Children.only expected to receive a single React element child.");
      return children;
    },
  };

  // --- component types --------------------------------------------------------------------

  function createContext(defaultValue: unknown) {
    const ctx: any = { $$typeof: CONTEXT, _currentValue: defaultValue, _defaultValue: defaultValue, displayName: undefined };
    ctx.Provider = { $$typeof: PROVIDER, _context: ctx };
    ctx.Consumer = { $$typeof: CONSUMER, _context: ctx };
    return ctx;
  }

  const memo = (type: any, compare?: (a: any, b: any) => boolean) => ({ $$typeof: MEMO, type, compare: compare ?? null });
  const forwardRef = (render: (props: any, ref: any) => unknown) => ({ $$typeof: FORWARD_REF, render });
  const lazy = (factory: () => Promise<any>) => ({ $$typeof: LAZY, _factory: factory, _status: -1, _result: null as any });

  class Component {
    props: any;
    context: any;
    state: any;
    refs: Record<string, unknown> = {};
    _inst?: Inst;
    static isReactComponent = {};
    constructor(props: any, context?: any) {
      this.props = props;
      this.context = context;
    }
    setState(partial: any, callback?: () => void) {
      const inst = this._inst;
      if (!inst || !inst.mounted) {
        // Before mount (constructor/componentWillMount): apply directly.
        const next = typeof partial === "function" ? partial(this.state, this.props) : partial;
        if (next) this.state = { ...this.state, ...next };
        return;
      }
      (inst.pendingState ??= []).push({ partial, callback });
      markDirty(inst);
    }
    forceUpdate(callback?: () => void) {
      const inst = this._inst;
      if (!inst) return;
      (inst.pendingState ??= []).push({ partial: null, callback });
      markDirty(inst);
    }
  }
  (Component.prototype as any).isReactComponent = {};
  class PureComponent extends Component {}
  (PureComponent.prototype as any).isPureReactComponent = true;

  function host(name: string, slots: string[] = [], handle?: () => Record<string, unknown>) {
    const fn: any = function GlideHostComponent() {
      throw new Error(`${name} is a host component and cannot be called directly`);
    };
    fn[HOST] = { name, slots, handle };
    fn.displayName = name;
    return fn;
  }

  // --- instances ----------------------------------------------------------------------------

  function kindOf(node: any): Kind {
    if (typeof node === "string" || typeof node === "number" || typeof node === "bigint") return "text";
    if (Array.isArray(node)) return "fragment";
    const t = node.type;
    if (t === SLOT_TYPE) return "slot";
    if (typeof t === "function") {
      if (t[HOST]) return "host";
      if (t.prototype && t.prototype.isReactComponent) return "class";
      return "fn";
    }
    if (typeof t === "string") return "host";
    if (t === FRAGMENT || t === STRICT || t === PROFILER) return "fragment";
    if (t === SUSPENSE) return "suspense";
    if (isObj(t)) {
      if (t.$$typeof === PROVIDER || t.$$typeof === CONTEXT) return "provider";
      if (t.$$typeof === CONSUMER) return "consumer";
      if (t.$$typeof === MEMO) return "memo";
      if (t.$$typeof === FORWARD_REF) return "forward";
      if (t.$$typeof === LAZY) return "lazy";
    }
    throw new Error(`Element type is invalid: expected a string or a class/function but got: ${t === undefined ? "undefined (check your imports)" : typeof t}`);
  }

  function newInst(kind: Kind, node: any, key: string | null, parent: Inst): Inst {
    const inst: Inst = {
      uid: ++uidSeq,
      kind,
      type: kind === "text" ? null : Array.isArray(node) ? FRAGMENT : node.type,
      key,
      element: node,
      props: kind === "text" ? null : Array.isArray(node) ? { children: node } : node.props,
      parent,
      children: [],
      hooks: [],
      depth: parent.depth + 1,
      root: parent.root,
      dirty: false,
      mounted: false,
      text: kind === "text" ? String(node) : undefined,
    };
    return inst;
  }

  function sameType(inst: Inst, kind: Kind, node: any): boolean {
    if (inst.kind !== kind) return false;
    if (kind === "text") return true;
    if (Array.isArray(node)) return inst.type === FRAGMENT && Array.isArray(inst.element);
    return inst.type === node.type && !Array.isArray(inst.element);
  }

  function markDirty(inst: Inst) {
    if (!inst.mounted && inst.kind !== "root") return;
    inst.dirty = true;
    dirty.add(inst);
    schedule();
  }

  function schedule() {
    if (scheduled || flushing) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      flush();
    });
  }

  // --- reconciliation ---------------------------------------------------------------------------

  function reconcileChildren(parent: Inst, children: unknown) {
    const list: Array<{ node: any; key: string }> = [];
    const push = (node: unknown, index: number) => {
      if (node === null || node === undefined || typeof node === "boolean") return;
      if (typeof node === "function" || typeof node === "symbol") return;
      if (isObj(node) && !isElement(node) && !Array.isArray(node)) {
        if (typeof (node as any)[Symbol.iterator] === "function") node = Array.from(node as Iterable<unknown>);
        else if (typeof (node as any).then === "function") throw node; // a promise as a child (use())
        else throw new Error(`Objects are not valid as a React child (found: object with keys {${Object.keys(node).join(", ")}})`);
      }
      const explicit = isElement(node) ? (node as any).key : null;
      list.push({ node, key: explicit !== null ? `k:${explicit}` : `i:${index}` });
    };
    if (Array.isArray(children)) children.forEach(push);
    else push(children, 0);

    const old = new Map<string, Inst>();
    for (const c of parent.children) old.set(c.key ?? "", c);
    const next: Inst[] = [];
    const seen = new Set<string>();
    for (const { node, key } of list) {
      let k = key;
      while (seen.has(k)) k += "~"; // duplicate keys: keep both
      seen.add(k);
      const kind = kindOf(node);
      const prev = old.get(k);
      if (prev && sameType(prev, kind, node)) {
        old.delete(k);
        updateInst(prev, node);
        next.push(prev);
      } else {
        const inst = newInst(kind, node, k, parent);
        mountInst(inst);
        next.push(inst);
      }
    }
    for (const rest of old.values()) unmountInst(rest);
    parent.children = next;
  }

  function mountInst(inst: Inst) {
    inst.mounted = true;
    renderInst(inst);
  }

  function shallowEqual(a: any, b: any): boolean {
    if (is(a, b)) return true;
    if (!isObj(a) || !isObj(b)) return false;
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && is(a[k], b[k]));
  }

  function contextChanged(inst: Inst): boolean {
    if (!inst.ctxDeps) return false;
    for (const [ctx, value] of inst.ctxDeps) if (!is(readContext(inst, ctx), value)) return true;
    return false;
  }

  function updateInst(inst: Inst, node: any) {
    if (inst.kind === "text") {
      inst.text = String(node);
      inst.element = node;
      inst.root.changed = true;
      return;
    }
    const prevElement = inst.element;
    const prevProps = inst.props;
    inst.element = node;
    inst.props = Array.isArray(node) ? { children: node } : node.props;
    // Same element object and nothing pending: React bails out here too.
    if (prevElement === node && !inst.dirty && !contextChanged(inst)) return;
    if (inst.kind === "memo" && !inst.dirty && !contextChanged(inst)) {
      const cmp = inst.type.compare ?? shallowEqual;
      if (cmp(prevProps, inst.props)) return;
    }
    if (inst.kind === "class" && inst.classInst && !inst.dirty && inst.type.prototype.isPureReactComponent && shallowEqual(prevProps, inst.props)) return;
    renderInst(inst);
  }

  function readContext(inst: Inst | null, ctx: any): unknown {
    let p = inst?.parent ?? null;
    while (p) {
      if (p.kind === "provider" && (p.type === ctx || p.type._context === ctx)) return p.props.value;
      p = p.parent;
    }
    return ctx._defaultValue;
  }

  function markConsumers(inst: Inst, ctx: any) {
    for (const c of inst.children) {
      if (c.ctxDeps?.has(ctx)) markDirty(c);
      if (c.kind === "provider" && (c.type === ctx || c.type._context === ctx)) continue; // shadowed
      markConsumers(c, ctx);
    }
  }

  function renderInst(inst: Inst) {
    inst.dirty = false;
    dirty.delete(inst);
    inst.root.changed = true;
    try {
      switch (inst.kind) {
        case "root":
          reconcileChildren(inst, inst.props.children);
          break;
        case "host": {
          const meta = inst.type[HOST] as { name: string; slots: string[] } | undefined;
          const slots = meta?.slots ?? [];
          const slotChildren: any[] = [];
          // Children first, then each slot as its own keyed subtree.
          slotChildren.push(makeSlot("children", inst.props.children));
          for (const s of slots) if (inst.props[s] !== undefined && inst.props[s] !== null && inst.props[s] !== false) slotChildren.push(makeSlot(s, inst.props[s]));
          reconcileChildren(inst, slotChildren);
          break;
        }
        case "slot":
          reconcileChildren(inst, inst.props.children);
          break;
        case "fragment":
          reconcileChildren(inst, inst.props.children);
          break;
        case "provider": {
          const ctx = inst.type._context ?? inst.type;
          const prev = (inst as any)._lastValue;
          if (inst.mounted && (inst as any)._hasValue && !is(prev, inst.props.value)) markConsumers(inst, ctx);
          (inst as any)._lastValue = inst.props.value;
          (inst as any)._hasValue = true;
          reconcileChildren(inst, inst.props.children);
          break;
        }
        case "consumer": {
          const ctx = inst.type._context;
          const value = readContext(inst, ctx);
          (inst.ctxDeps ??= new Map()).set(ctx, value);
          const fn = inst.props.children;
          reconcileChildren(inst, typeof fn === "function" ? fn(value) : null);
          break;
        }
        case "fn":
        case "forward":
        case "memo":
          reconcileChildren(inst, callComponent(inst));
          break;
        case "class":
          reconcileChildren(inst, renderClass(inst));
          break;
        case "suspense":
          reconcileChildren(inst, inst.suspended ? (inst.props.fallback ?? null) : inst.props.children);
          break;
        case "lazy": {
          const lz = inst.type;
          if (lz._status === 1) {
            const C = lz._result;
            reconcileChildren(inst, createElement(C, inst.props));
          } else {
            if (lz._status === -1) {
              lz._status = 0;
              lz._result = lz._factory().then(
                (m: any) => {
                  lz._status = 1;
                  lz._result = m && m.default !== undefined ? m.default : m;
                },
                (e: unknown) => {
                  lz._status = 2;
                  lz._result = e;
                },
              );
            }
            if (lz._status === 2) throw lz._result;
            throw lz._result;
          }
          break;
        }
        case "text":
          break;
      }
    } catch (err) {
      handleThrow(inst, err);
    }
    committed.push(inst);
  }

  function makeSlot(name: string, children: unknown) {
    return { $$typeof: ELEMENT, type: SLOT_TYPE, key: `slot:${name}`, ref: null, props: { name, children }, _owner: null, _store: {} };
  }
  function callComponent(inst: Inst): unknown {
    const prev = current;
    current = inst;
    hookIndex = 0;
    try {
      if (inst.kind === "forward") {
        const { ref, ...rest } = inst.props;
        return inst.type.render(rest, ref ?? null);
      }
      if (inst.kind === "memo") {
        const inner = inst.type.type;
        if (isObj(inner) && inner.$$typeof === FORWARD_REF) {
          const { ref, ...rest } = inst.props;
          return inner.render(rest, ref ?? null);
        }
        if (typeof inner === "function" && inner.prototype?.isReactComponent) {
          current = prev;
          return createElement(inner, inst.props);
        }
        return inner(inst.props);
      }
      return inst.type(inst.props);
    } finally {
      current = prev;
    }
  }

  function renderClass(inst: Inst): unknown {
    const C = inst.type;
    const ctxType = C.contextType;
    const context = ctxType ? readContext(inst, ctxType) : undefined;
    if (ctxType) (inst.ctxDeps ??= new Map()).set(ctxType, context);
    let c = inst.classInst;
    if (!c) {
      c = new C(inst.props, context);
      c._inst = inst;
      c.props = inst.props;
      c.context = context;
      if (c.state === undefined) c.state = null;
      inst.classInst = c;
      if (C.getDerivedStateFromProps) c.state = { ...c.state, ...C.getDerivedStateFromProps(inst.props, c.state) };
      inst.didMount = false;
      const first = c.render();
      (inst as any)._lastRender = first;
      return first;
    }
    const prevProps = c.props;
    const prevState = c.state;
    let state = c.state;
    const callbacks: Array<() => void> = [];
    let force = false;
    for (const u of inst.pendingState ?? []) {
      if (u.partial === null) force = true;
      else {
        const next = typeof u.partial === "function" ? u.partial(state, inst.props) : u.partial;
        if (next) state = { ...state, ...next };
      }
      if (u.callback) callbacks.push(u.callback);
    }
    inst.pendingState = [];
    if (C.getDerivedStateFromProps) state = { ...state, ...C.getDerivedStateFromProps(inst.props, state) };
    if (!force && c.shouldComponentUpdate && !c.shouldComponentUpdate(inst.props, state, context)) {
      c.props = inst.props;
      c.state = state;
      return inst.children.length ? (inst as any)._lastRender : null;
    }
    c.props = inst.props;
    c.state = state;
    c.context = context;
    inst.prevPropsForUpdate = prevProps;
    inst.prevStateForUpdate = prevState;
    (inst as any)._callbacks = callbacks;
    const out = c.render();
    (inst as any)._lastRender = out;
    return out;
  }

  function handleThrow(inst: Inst, err: unknown) {
    inst.children.forEach(unmountInst);
    inst.children = [];
    if (isObj(err) && typeof (err as any).then === "function") {
      let p = inst.parent;
      while (p && p.kind !== "suspense") p = p.parent;
      if (!p) {
        inst.root.cb.onError(new Error("A component suspended while rendering, but no <Suspense> fallback was found."));
        return;
      }
      const boundary = p;
      if (!boundary.suspended) {
        boundary.suspended = true;
        markDirty(boundary);
      }
      const retry = () => {
        boundary.suspended = false;
        markDirty(boundary);
      };
      (err as PromiseLike<unknown>).then(retry, retry);
      return;
    }
    let p = inst.parent;
    while (p) {
      if (p.kind === "class" && (p.type.getDerivedStateFromError || p.classInst?.componentDidCatch) && !p.errorCaught) break;
      p = p.parent;
    }
    if (!p) {
      inst.root.cb.onError(err);
      return;
    }
    const b = p;
    b.errorCaught = err;
    const update = b.type.getDerivedStateFromError ? b.type.getDerivedStateFromError(err) : null;
    (b.pendingState ??= []).push({ partial: update ?? {}, callback: () => b.classInst?.componentDidCatch?.(err, { componentStack: "" }) });
    markDirty(b);
  }

  function unmountInst(inst: Inst) {
    if (!inst.mounted && inst.kind !== "text") return;
    inst.mounted = false;
    inst.root.changed = true;
    dirty.delete(inst);
    for (const c of inst.children) unmountInst(c);
    deletions.push(inst);
  }

  // --- hooks -----------------------------------------------------------------------------------

  function hook(tag: Hook["tag"]): Hook {
    const inst = current;
    if (!inst) throw new Error("Invalid hook call. Hooks can only be called inside the body of a function component.");
    let h = inst.hooks[hookIndex];
    if (!h) {
      h = { tag };
      inst.hooks[hookIndex] = h;
    }
    hookIndex++;
    return h;
  }

  const basicReducer = (s: any, a: any) => (typeof a === "function" ? a(s) : a);

  function useReducer(reducer: (s: any, a: any) => any, initialArg: any, init?: (a: any) => any) {
    const inst = current as Inst;
    const h = hook("state");
    if (!h.dispatch) {
      h.state = init ? init(initialArg) : initialArg;
      h.queue = [];
      h.dispatch = (action: any) => {
        if (!inst.mounted) return;
        if (!h.queue!.length && h.reducer === basicReducer) {
          // Eager bail-out: same value, nothing to do.
          const next = basicReducer(h.state, action);
          if (is(next, h.state)) return;
          h.queue!.push(() => next);
        } else h.queue!.push(action);
        markDirty(inst);
      };
    }
    h.reducer = reducer;
    if (h.queue!.length) {
      let s = h.state;
      for (const a of h.queue!) s = reducer === basicReducer ? basicReducer(s, a) : reducer(s, a);
      h.queue = [];
      h.state = s;
    }
    return [h.state, h.dispatch];
  }

  function useState(initial: any) {
    return useReducer(basicReducer, initial, typeof initial === "function" ? (f: () => unknown) => f() : undefined);
  }

  function effectHook(tag: "effect" | "layout", create: () => unknown, deps?: unknown[] | null) {
    const h = hook(tag);
    const d = deps === undefined ? null : deps;
    if (h.deps === undefined || d === null || depsChanged(h.deps, d)) {
      h.create = create;
      h.deps = d;
    }
  }

  const useEffect = (create: () => unknown, deps?: unknown[]) => effectHook("effect", create, deps);
  const useLayoutEffect = (create: () => unknown, deps?: unknown[]) => effectHook("layout", create, deps);

  function useMemo<T>(factory: () => T, deps?: unknown[]): T {
    const h = hook("memo");
    if (h.deps === undefined || !deps || depsChanged(h.deps, deps)) {
      h.value = factory();
      h.deps = deps ?? null;
    }
    return h.value;
  }

  const useCallback = <T,>(fn: T, deps?: unknown[]): T => useMemo(() => fn, deps);

  function useRef<T>(initial?: T) {
    const h = hook("ref");
    if (!h.value) h.value = { current: initial };
    return h.value as { current: T };
  }

  function useContext(ctx: any) {
    const inst = current as Inst;
    const value = readContext(inst, ctx);
    (inst.ctxDeps ??= new Map()).set(ctx, value);
    return value;
  }

  function useId() {
    const h = hook("id");
    if (!h.value) h.value = `:r${(++idSeq).toString(36)}:`;
    return h.value;
  }

  function useSyncExternalStore<T>(subscribe: (cb: () => void) => () => void, getSnapshot: () => T) {
    const inst = current as Inst;
    const h = hook("store");
    const value = getSnapshot();
    h.value = value;
    const ref = useRef({ getSnapshot, value });
    ref.current.getSnapshot = getSnapshot;
    ref.current.value = value;
    useEffect(() => {
      const check = () => {
        const next = ref.current.getSnapshot();
        if (!is(next, ref.current.value)) markDirty(inst);
      };
      check();
      return subscribe(check);
    }, [subscribe]);
    return value;
  }

  function useImperativeHandle(ref: any, create: () => unknown, deps?: unknown[]) {
    useLayoutEffect(
      () => {
        if (!ref) return;
        const v = create();
        if (typeof ref === "function") {
          ref(v);
          return () => ref(null);
        }
        ref.current = v;
        return () => {
          ref.current = null;
        };
      },
      deps ? [...deps, ref] : undefined,
    );
  }

  function useTransition(): [boolean, (fn: () => void) => void] {
    return [false, (fn) => fn()];
  }

  function use(usable: any) {
    if (isObj(usable) && (usable.$$typeof === CONTEXT || usable.$$typeof === PROVIDER)) return useContext(usable._context ?? usable);
    if (isObj(usable) && typeof usable.then === "function") {
      if (usable.status === "fulfilled") return usable.value;
      if (usable.status === "rejected") throw usable.reason;
      if (!usable.status) {
        usable.status = "pending";
        usable.then(
          (v: unknown) => {
            usable.status = "fulfilled";
            usable.value = v;
          },
          (e: unknown) => {
            usable.status = "rejected";
            usable.reason = e;
          },
        );
      }
      throw usable;
    }
    throw new Error("An unsupported type was passed to use()");
  }

  function useOptimistic<T>(state: T) {
    return [state, () => undefined];
  }

  function useActionState(action: (s: any, p: any) => any, initial: any) {
    const [state, setState] = useState(initial);
    const [pending, setPending] = useState(false);
    const dispatch = useCallback(
      async (payload: any) => {
        setPending(true);
        try {
          setState(await action(state, payload));
        } finally {
          setPending(false);
        }
      },
      [state],
    );
    return [state, dispatch, pending];
  }

  // --- commit ------------------------------------------------------------------------------------

  function setRef(ref: any, value: unknown): (() => void) | void {
    if (!ref) return;
    if (typeof ref === "function") {
      const r = ref(value);
      return typeof r === "function" ? r : () => ref(null);
    }
    if (isObj(ref)) {
      ref.current = value;
      return () => {
        ref.current = null;
      };
    }
  }

  function runCleanup(fn: (() => void) | void, root: RootState) {
    if (typeof fn !== "function") return;
    try {
      fn();
    } catch (err) {
      root.cb.onError(err);
    }
  }

  function commit() {
    const dels = deletions;
    deletions = [];
    const list = committed;
    committed = [];
    // 1. unmounts: refs and every effect cleanup (children were pushed before parents).
    for (const inst of dels) {
      if (inst.refCleanup) runCleanup(inst.refCleanup, inst.root);
      inst.refCleanup = undefined;
      for (const h of inst.hooks) if ((h.tag === "effect" || h.tag === "layout") && h.cleanup) runCleanup(h.cleanup, inst.root);
      if (inst.classInst?.componentWillUnmount) runCleanup(() => inst.classInst.componentWillUnmount(), inst.root);
    }
    // 2. refs and layout effects / class lifecycles, child-first.
    for (const inst of list) {
      if (!inst.mounted) continue;
      const ref = inst.kind === "host" ? inst.props?.ref : inst.kind === "class" ? inst.element?.props?.ref : undefined;
      if (inst.kind === "host" || inst.kind === "class") {
        if (ref !== inst.ref) {
          if (inst.refCleanup) runCleanup(inst.refCleanup, inst.root);
          const value = inst.kind === "class" ? inst.classInst : (inst.handle ??= makeHandle(inst));
          inst.refCleanup = setRef(ref, value);
          inst.ref = ref;
        }
      }
      for (const h of inst.hooks) {
        if (h.tag !== "layout" || !h.create) continue;
        runCleanup(h.cleanup, inst.root);
        const create = h.create;
        h.create = null;
        try {
          h.cleanup = create() as (() => void) | void;
        } catch (err) {
          inst.root.cb.onError(err);
        }
      }
      const c = inst.classInst;
      if (c) {
        try {
          if (!inst.didMount) {
            inst.didMount = true;
            c.componentDidMount?.();
          } else if (inst.prevPropsForUpdate !== undefined) {
            c.componentDidUpdate?.(inst.prevPropsForUpdate, inst.prevStateForUpdate);
            inst.prevPropsForUpdate = undefined;
          }
          for (const cb of (inst as any)._callbacks ?? []) cb.call(c);
          (inst as any)._callbacks = [];
        } catch (err) {
          handleThrow(inst, err);
        }
        if (inst.errorCaught !== undefined && !(inst.pendingState ?? []).length) inst.errorCaught = undefined;
      }
    }
    // 3. passive effects: all cleanups first, then all creates.
    const passive: Array<[Inst, Hook]> = [];
    for (const inst of list) {
      if (!inst.mounted) continue;
      for (const h of inst.hooks) if (h.tag === "effect" && h.create) passive.push([inst, h]);
    }
    for (const [inst, h] of passive) {
      runCleanup(h.cleanup, inst.root);
      h.cleanup = undefined;
    }
    for (const [inst, h] of passive) {
      const create = h.create!;
      h.create = null;
      if (!inst.mounted) continue;
      try {
        const r = create();
        h.cleanup = typeof r === "function" ? (r as () => void) : undefined;
      } catch (err) {
        inst.root.cb.onError(err);
      }
    }
  }

  function makeHandle(inst: Inst): unknown {
    const meta = inst.type?.[HOST] as { handle?: () => Record<string, unknown> } | undefined;
    return meta?.handle ? meta.handle() : {};
  }

  const roots = new Set<RootState>();

  function flush() {
    if (flushing) return;
    flushing = true;
    try {
      for (let pass = 0; pass < 50; pass++) {
        if (!dirty.size && !committed.length && !deletions.length) break;
        const batch = Array.from(dirty).sort((a, b) => a.depth - b.depth);
        for (const inst of batch) {
          if (!inst.dirty) continue; // re-rendered by an ancestor in this pass
          if (!inst.mounted && inst.kind !== "root") {
            dirty.delete(inst);
            continue;
          }
          renderInst(inst);
        }
        commit();
      }
      if (dirty.size) {
        // An update loop (effects that keep setting state): yield to the event loop instead of spinning.
        setTimeout(() => flush(), 0);
      }
    } finally {
      flushing = false;
    }
    for (const r of roots) {
      if (r.changed && r.alive) {
        r.changed = false;
        try {
          r.cb.onCommit();
        } catch (err) {
          r.cb.onError(err);
        }
      }
    }
  }

  function hostTree(inst: Inst): HostNode[] {
    const out: HostNode[] = [];
    for (const c of inst.children) {
      if (c.kind === "text") out.push({ type: "#text", uid: c.uid, key: c.key, props: {}, children: [], slots: {}, text: c.text });
      else if (c.kind === "host") {
        const node: HostNode = { type: c.type[HOST]?.name ?? String(c.type), uid: c.uid, key: c.element?.key ?? null, props: {}, children: [], slots: {} };
        const slotNames: string[] = c.type[HOST]?.slots ?? [];
        for (const k of Object.keys(c.props)) if (k !== "children" && k !== "ref" && !slotNames.includes(k)) node.props[k] = c.props[k];
        for (const s of c.children) {
          if (s.kind !== "slot") continue;
          const name = s.props.name as string;
          if (name === "children") node.children = hostTree(s);
          else node.slots[name] = hostTree(s);
        }
        out.push(node);
      } else out.push(...hostTree(c));
    }
    return out;
  }

  function createRoot(cb: RootCallbacks): MiniRoot {
    const state: RootState = { inst: null as unknown as Inst, cb, changed: false, alive: true };
    const inst: Inst = {
      uid: ++uidSeq,
      kind: "root",
      type: null,
      key: null,
      element: null,
      props: { children: null },
      parent: null,
      children: [],
      hooks: [],
      depth: 0,
      root: state,
      dirty: false,
      mounted: true,
    };
    state.inst = inst;
    roots.add(state);
    return {
      render(element) {
        inst.props = { children: element };
        markDirty(inst);
      },
      unmount() {
        if (!state.alive) return;
        state.alive = false;
        for (const c of inst.children) unmountInst(c);
        inst.children = [];
        roots.delete(state);
        if (!flushing) commit();
      },
      tree: () => hostTree(inst),
    };
  }

  function startTransition(fn: () => void) {
    fn();
  }

  function flushSync<T>(fn?: () => T): T | undefined {
    const r = fn?.();
    flush();
    return r;
  }

  const React: Record<string, any> = {
    Children,
    Component,
    PureComponent,
    Fragment: FRAGMENT,
    StrictMode: STRICT,
    Profiler: PROFILER,
    Suspense: SUSPENSE,
    createElement,
    cloneElement,
    createContext,
    createRef: () => ({ current: null }),
    forwardRef,
    isValidElement: isElement,
    lazy,
    memo,
    startTransition,
    use,
    useActionState,
    useCallback,
    useContext,
    useDebugValue: () => undefined,
    useDeferredValue: <T,>(v: T) => v,
    useEffect,
    useId,
    useImperativeHandle,
    useInsertionEffect: useLayoutEffect,
    useLayoutEffect,
    useMemo,
    useOptimistic,
    useReducer,
    useRef,
    useState,
    useSyncExternalStore,
    useTransition,
    version: "19.0.0-glide",
    __GLIDE_MINI_REACT__: true,
  };
  React.default = React;

  const jsxRuntime: Record<string, any> = { jsx, jsxs: jsx, jsxDEV: jsx, Fragment: FRAGMENT };
  jsxRuntime.default = jsxRuntime;

  return { React, jsxRuntime, createRoot, host, flush };
}
