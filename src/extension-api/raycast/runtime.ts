/**
 * Extension-process runtime for Raycast-style commands: renders the command's React tree with
 * the mini React runtime, keeps one root per navigation level (useNavigation push/pop), sends
 * each commit to main as a view model and routes UI events back to the registered handlers.
 *
 * `raycastRuntime` is self-contained like the other factories; `buildRaycastRunnerSource`
 * stitches all of them into raycast-runner.cjs.
 */
import { createMiniReact, type MiniReact, type MiniRoot } from "./react";
import { createRaycastSerializer, type RaycastSerializer, type SerializeContext } from "./serialize";
import { createRaycastApi, type RaycastBridge } from "./api";
import { createRaycastUtils } from "./utils";
import type { ChildMessage, FormFieldType, FormValue, InitPayload, JsonValue, ParentMessage, RequestMethod, ViewModel } from "../types";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface RaycastPort {
  send(msg: ChildMessage): void;
  onMessage(cb: (msg: ParentMessage) => void): void;
}

export interface RaycastFactories {
  createMiniReact: typeof createMiniReact;
  createRaycastSerializer: typeof createRaycastSerializer;
  createRaycastApi: typeof createRaycastApi;
  createRaycastUtils: typeof createRaycastUtils;
}

export interface RaycastRuntime {
  mr: MiniReact;
  ser: RaycastSerializer;
  api: Record<string, any>;
  utils: Record<string, any>;
  handle(msg: ParentMessage): void;
  /** Render an element as the root view (tests). */
  renderRoot(element: unknown): void;
  /** Last view sent per depth (tests). */
  views: Array<ViewModel | null>;
}

/** Shim modules that `require("react")` etc. resolve to inside the extension process. */
export const RAYCAST_SHIMS: Record<string, string> = {
  "rc-react.cjs": `"use strict";\nmodule.exports = globalThis.__glideRaycast.React;\n`,
  "rc-jsx-runtime.cjs": `"use strict";\nmodule.exports = globalThis.__glideRaycast.jsxRuntime;\n`,
  "rc-api.cjs": `"use strict";\nmodule.exports = globalThis.__glideRaycast.api;\n`,
  "rc-utils.cjs": `"use strict";\nmodule.exports = globalThis.__glideRaycast.utils;\n`,
};

export function raycastRuntime(nodeRequire: (id: string) => any, port: RaycastPort, f: RaycastFactories): RaycastRuntime {
  const mr = f.createMiniReact();
  const ser = f.createRaycastSerializer();
  const React = mr.React;
  let init: InitPayload | null = null;
  let requestSeq = 0;
  const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void; onChunk?: (chunk: string) => void }>();

  const send = (msg: ChildMessage) => port.send(msg);
  const request = (method: RequestMethod, params: JsonValue[], onChunk?: (chunk: string) => void): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = ++requestSeq;
      pending.set(id, { resolve, reject, onChunk });
      send({ type: "request", id, method, params });
    });

  const bridge: RaycastBridge = {
    request,
    init: () => init ?? ({ preferences: {} } as unknown as InitPayload),
    nodeRequire,
  };
  const api = f.createRaycastApi(mr, ser, bridge);
  const utils = f.createRaycastUtils(React, api, nodeRequire);
  const NavigationContext = api.__glide.NavigationContext;

  const errorInfo = (err: unknown) => {
    const e = err instanceof Error ? err : new Error(String(err));
    return { message: e.message, stack: e.stack };
  };

  // --- navigation stack ---------------------------------------------------------------------------
  interface Level {
    depth: number;
    root: MiniRoot;
    handlers: Map<string, (...a: any[]) => unknown>;
    fieldTypes: Record<string, FormFieldType>;
    sent: boolean;
    onPop?: () => void;
    alive: boolean;
  }
  const stack: Level[] = [];
  const views: Array<ViewModel | null> = [];
  const dropdownValues = new Map<number, string>();
  const dropdownInit = new Set<number>();
  let formCache: any = null;
  const cache = () => (formCache ??= new api.Cache({ namespace: "glide-form-values" }));
  let draftCache: any = null;
  const drafts = () => (draftCache ??= new api.Cache({ namespace: "glide-form-drafts" }));
  type Draft = Record<string, { type: FormFieldType; value: FormValue }>;
  const readDrafts = (): Draft => {
    try {
      const raw = drafts().get(String(api.environment.commandName));
      const d = raw ? JSON.parse(raw) : {};
      return d && typeof d === "object" ? d : {};
    } catch {
      return {};
    }
  };

  function decodeValue(type: FormFieldType, v: FormValue | null | undefined): unknown {
    if (type === "checkbox") return v === true;
    if (type === "date" || type === "datetime") {
      if (typeof v !== "string" || !v) return null;
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    if (type === "tags" || type === "file") return Array.isArray(v) ? v.map(String) : typeof v === "string" && v ? [v] : [];
    return v === undefined || v === null ? "" : String(v);
  }

  function errorModel(err: unknown): ViewModel {
    const { message, stack: trace } = errorInfo(err);
    const env = api.environment;
    return {
      type: "detail",
      title: "Extension error",
      markdown: `# ${env.commandName || "Command"} failed\n\n${message}${trace ? `\n\n\`\`\`\n${trace.split("\n").slice(0, 12).join("\n")}\n\`\`\`` : ""}`,
      metadata: [{ label: "Extension", text: String(env.extensionName || "") }],
      actions: [],
      isLoading: false,
    };
  }

  function emit(level: Level, view: ViewModel) {
    views[level.depth] = view;
    const type = level.sent || level.depth === 0 ? "render" : "push";
    level.sent = true;
    send({ type, depth: level.depth, view });
  }

  function commitLevel(level: Level) {
    if (!level.alive) return;
    const handlers = new Map<string, (...a: any[]) => unknown>();
    const ctx: SerializeContext = {
      register: (uid, name, fn) => {
        const id = `${uid}.${name}`;
        handlers.set(id, fn);
        return id;
      },
      push: (element, onPop) => push(element, onPop),
      decodeValues: (values) => {
        const out: Record<string, unknown> = {};
        for (const [k, t] of Object.entries(level.fieldTypes)) out[k] = decodeValue(t, values[k]);
        for (const [k, v] of Object.entries(values)) if (!(k in out)) out[k] = v;
        return out;
      },
      decodeValue,
      dropdownValue: (uid, fallback, storeKey) => {
        if (dropdownValues.has(uid)) return dropdownValues.get(uid);
        const stored = storeKey ? cache().get(storeKey) : undefined;
        const v = stored ?? fallback;
        if (v !== undefined) dropdownValues.set(uid, v);
        return v;
      },
      setDropdownValue: (uid, v, storeKey) => {
        dropdownValues.set(uid, v);
        if (storeKey) cache().set(storeKey, v);
      },
      initialDropdown: (uid, value, onChange) => {
        if (dropdownInit.has(uid)) return;
        dropdownInit.add(uid);
        queueMicrotask(() => {
          try {
            onChange(value);
          } catch (err) {
            reportError(err);
          }
        });
      },
      storedValue: (id) => {
        const raw = cache().get(`${api.environment.commandName}:${id}`);
        if (raw === undefined) return undefined;
        try {
          return JSON.parse(raw) as FormValue;
        } catch {
          return undefined;
        }
      },
      storeValue: (id, v) => cache().set(`${api.environment.commandName}:${id}`, JSON.stringify(v)),
      draftValue: (id) => readDrafts()[id]?.value,
      saveDraft: (id, type, value) => drafts().set(String(api.environment.commandName), JSON.stringify({ ...readDrafts(), [id]: { type, value } })),
      clearDrafts: () => void drafts().remove(String(api.environment.commandName)),
      unsupported: (feature) => void api.showToast({ style: "FAILURE", title: `${feature} is not supported in Glide yet` }),
    };
    let result;
    try {
      result = ser.serialize(level.root.tree(), ctx);
    } catch (err) {
      reportError(err);
      emit(level, errorModel(err));
      return;
    }
    level.handlers = handlers;
    level.fieldTypes = result.fieldTypes;
    if (result.view) emit(level, result.view);
  }

  function mount(element: unknown, depth: number, onPop?: () => void): Level {
    const level: Level = { depth, root: null as unknown as MiniRoot, handlers: new Map(), fieldTypes: {}, sent: false, onPop, alive: true };
    const nav = {
      push: (el: unknown, cb?: () => void) => push(el, cb),
      pop: () => pop(depth),
    };
    level.root = mr.createRoot({
      onCommit: () => commitLevel(level),
      onError: (err) => {
        reportError(err);
        if (level.alive) emit(level, errorModel(err));
      },
    });
    stack[depth] = level;
    level.root.render(React.createElement(NavigationContext.Provider, { value: nav }, element));
    return level;
  }

  function closeFrom(depth: number) {
    for (let d = stack.length - 1; d >= depth; d--) {
      const level = stack[d];
      if (!level) continue;
      level.alive = false;
      level.root.unmount();
      try {
        level.onPop?.();
      } catch (err) {
        reportError(err);
      }
    }
    stack.length = Math.min(stack.length, depth);
    views.length = Math.min(views.length, depth);
  }

  function push(element: unknown, onPop?: () => void) {
    if (!React.isValidElement(element)) {
      reportError(new TypeError("Action.Push / push() needs a React element as its target"));
      return;
    }
    mount(element, stack.length, onPop);
  }

  function pop(depth?: number) {
    const top = depth ?? stack.length - 1;
    if (top < 0) return;
    send({ type: "pop", depth: top });
    if (top > 0) closeFrom(top);
  }

  function reportError(err: unknown) {
    const { message, stack: trace } = errorInfo(err);
    send({ type: "log", level: "error", text: trace ?? message });
  }

  // --- module resolution ------------------------------------------------------------------------------
  function installResolver(shimDir: string) {
    (globalThis as any).__glideRaycast = { React, jsxRuntime: mr.jsxRuntime, api, utils };
    const Module = nodeRequire("node:module") as { _resolveFilename(this: unknown, request: string, ...rest: unknown[]): string };
    const path = nodeRequire("node:path");
    const map: Record<string, string> = {
      react: "rc-react.cjs",
      "react/jsx-runtime": "rc-jsx-runtime.cjs",
      "react/jsx-dev-runtime": "rc-jsx-runtime.cjs",
      "@raycast/api": "rc-api.cjs",
      "@raycast/utils": "rc-utils.cjs",
      "@glide/raycast": "rc-api.cjs",
    };
    const original = Module._resolveFilename;
    Module._resolveFilename = function (req: string, ...rest: unknown[]) {
      const hit = map[req];
      if (hit) return path.join(shimDir, hit);
      return original.call(this, req, ...rest);
    };
  }

  function start(payload: InitPayload) {
    init = payload;
    const env = payload.environment;
    Object.assign(api.environment, {
      assetsPath: env.assetsPath,
      commandMode: env.commandMode,
      commandName: env.commandName,
      extensionName: env.extensionName,
      supportPath: env.supportPath,
      launchType: payload.launchType ?? "userInitiated",
      ownerOrAuthorName: "",
    });
    if (payload.shimDir) installResolver(payload.shimDir);
    let mod: any;
    try {
      mod = nodeRequire(payload.commandPath);
    } catch (err) {
      fail(err);
      return;
    }
    const entry = mod && typeof mod === "object" && "default" in mod ? mod.default : mod;
    if (typeof entry !== "function") return fail(new TypeError(`${payload.commandPath} must export a default React component or function`));
    const draft = readDrafts();
    const draftValues = Object.keys(draft).length ? Object.fromEntries(Object.entries(draft).map(([k, d]) => [k, decodeValue(d.type, d.value)])) : undefined;
    const props = { arguments: payload.arguments ?? {}, launchType: payload.launchType ?? "userInitiated", launchContext: payload.launchContext ?? undefined, fallbackText: undefined, draftValues };
    if (env.commandMode === "no-view") {
      Promise.resolve()
        .then(() => entry(props))
        .then(
          () => send({ type: "done" }),
          (err: unknown) => fail(err),
        );
      return;
    }
    mount(React.createElement(entry, props), 0);
  }

  function fail(err: unknown) {
    const { message, stack: trace } = errorInfo(err);
    send({ type: "error", message, stack: trace });
  }

  async function invoke(depth: number, handler: string, args: JsonValue[]) {
    const fn = handler.startsWith("toast:") ? api.__glide.toastHandlers.get(handler) : stack[depth]?.handlers.get(handler);
    if (!fn) return; // stale handler from an unmounted view
    try {
      await fn(...args);
    } catch (err) {
      reportError(err);
      await request("showToast", ["failure", errorInfo(err).message, null, null]).catch(() => undefined);
    }
  }

  function handle(msg: ParentMessage) {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "init") start(msg.init);
    else if (msg.type === "invoke") void invoke(msg.depth, msg.handler, Array.isArray(msg.args) ? msg.args : []);
    else if (msg.type === "closeView") closeFrom(Math.max(1, msg.depth));
    else if (msg.type === "stream") pending.get(msg.id)?.onChunk?.(String(msg.chunk ?? ""));
    else if (msg.type === "response") {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg.result);
    }
  }

  port.onMessage(handle);
  return { mr, ser, api, utils, handle, renderRoot: (el) => void mount(el, 0), views };
}

/** Source of raycast-runner.cjs (utilityProcess parentPort or fork IPC). */
export function buildRaycastRunnerSource(): string {
  return [
    '"use strict";',
    "const pp = process.parentPort;",
    "const port = pp",
    "  ? { send: (m) => pp.postMessage(m), onMessage: (cb) => pp.on('message', (e) => cb(e.data)) }",
    "  : { send: (m) => process.send && process.send(m), onMessage: (cb) => process.on('message', cb) };",
    "const fmt = (e) => ({ type: 'error', message: String((e && e.message) || e), stack: e && e.stack });",
    "process.on('uncaughtException', (e) => port.send({ type: 'log', level: 'error', text: String((e && e.stack) || e) }));",
    "process.on('unhandledRejection', (e) => { port.send({ type: 'log', level: 'error', text: String((e && e.stack) || e) }); port.send({ type: 'request', id: -1, method: 'showToast', params: ['failure', fmt(e).message, null, null] }); });",
    "const factories = {",
    `  createMiniReact: ${createMiniReact.toString()},`,
    `  createRaycastSerializer: ${createRaycastSerializer.toString()},`,
    `  createRaycastApi: ${createRaycastApi.toString()},`,
    `  createRaycastUtils: ${createRaycastUtils.toString()},`,
    "};",
    `(${raycastRuntime.toString()})(require, port, factories);`,
    "",
  ].join("\n");
}
