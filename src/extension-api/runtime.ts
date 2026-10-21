/**
 * The extension-process runtime: implements `@glide/api` and runs one command.
 *
 * `glideRuntime` must stay fully self-contained (no references to anything outside its
 * body except its parameters and globals) because main serialises it with
 * Function.prototype.toString into <feature data>/runtime/runner.cjs, which an Electron
 * utilityProcess (or a plain `child_process.fork` in tests) executes. Types are erased,
 * so importing types is fine.
 */
import type {
  ActionDescriptor,
  ActionModel,
  ChildMessage,
  CommandContext,
  DetailView,
  Environment,
  FormFieldModel,
  FormView,
  InitPayload,
  JsonValue,
  ListItemModel,
  ListView,
  Navigation,
  ParentMessage,
  RequestMethod,
  ToastOptions,
  View,
  ViewFactory,
  ViewModel,
} from "./types";

export interface RuntimePort {
  send(msg: ChildMessage): void;
  onMessage(cb: (msg: ParentMessage) => void): void;
}

export type NodeRequireLike = (id: string) => unknown;

/** Contents of the file `require("@glide/api")` resolves to inside the extension process. */
export const API_SHIM_SOURCE = `"use strict";\nmodule.exports = globalThis.__glideApi;\n`;

/** Exposed for tests: the object `@glide/api` exports. */
export interface GlideApiRuntime {
  api: Record<string, unknown>;
  serialize(view: View, depth: number): ViewModel;
  handle(msg: ParentMessage): void;
}

export function glideRuntime(nodeRequire: NodeRequireLike, port: RuntimePort): GlideApiRuntime {
  type Fn = (...args: never[]) => unknown;
  const handlers = new Map<number, Map<string, Fn>>();
  const navGeneration = new Map<number, number>();
  const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  let handlerSeq = 0;
  let requestSeq = 0;
  let preferences: Record<string, string | boolean> = {};
  const environment: Partial<Environment> = {};

  const send = (msg: ChildMessage) => port.send(msg);

  const request = (method: RequestMethod, params: JsonValue[]): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = ++requestSeq;
      pending.set(id, { resolve, reject });
      send({ type: "request", id, method, params });
    });

  const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
  const str = (v: unknown): string | undefined => (v === undefined || v === null ? undefined : String(v));

  // --- serialisation --------------------------------------------------------
  function serialize(view: View, depth: number): ViewModel {
    if (!view || typeof view !== "object") throw new TypeError("render() expects a view created with List(), Detail() or Form()");
    const table = new Map<string, Fn>();
    let actionSeq = 0;
    const register = (fn: Fn): string => {
      const id = `h${++handlerSeq}`;
      table.set(id, fn);
      return id;
    };
    const DEFAULT_TITLES: Record<string, string> = { openInBrowser: "Open in Browser", copy: "Copy to Clipboard", paste: "Paste", push: "Show Details", run: "Run" };
    const action = (a: ActionDescriptor): ActionModel => {
      if (!a || typeof a !== "object" || !(a.kind in DEFAULT_TITLES)) throw new TypeError("Actions must be created with Action.OpenInBrowser/CopyToClipboard/Paste/Push/Run");
      const model: ActionModel = { id: `a${++actionSeq}`, kind: a.kind, title: str(a.title) ?? DEFAULT_TITLES[a.kind] };
      if (a.shortcut) model.shortcut = String(a.shortcut);
      if (a.icon) model.icon = String(a.icon);
      if (a.kind === "openInBrowser") model.url = String(a.url);
      else if (a.kind === "copy" || a.kind === "paste") model.text = String(a.text);
      else if (a.kind === "push") {
        const factory = a.factory;
        if (typeof factory !== "function") throw new TypeError("Action.Push needs a view factory function");
        model.handler = register(() => pushView(depth + 1, factory));
      } else {
        if (typeof a.handler !== "function") throw new TypeError("Action.Run needs a handler function");
        model.handler = register(a.handler as Fn);
      }
      return model;
    };
    const actions = (list: ActionDescriptor[] | undefined) => (Array.isArray(list) ? list.filter(Boolean).map(action) : []);

    let model: ViewModel;
    if (view.type === "list") {
      const v = view as ListView;
      const seen = new Set<string>();
      const items: ListItemModel[] = (Array.isArray(v.items) ? v.items : []).filter(Boolean).map((it, i) => {
        let id = str(it.id) ?? String(i);
        while (seen.has(id)) id = `${id}~`;
        seen.add(id);
        const out: ListItemModel = {
          id,
          title: String(it.title ?? ""),
          accessories: Array.isArray(it.accessories) ? it.accessories.filter(Boolean).map((a) => ({ text: str(a.text), tag: str(a.tag), icon: str(a.icon), tooltip: str(a.tooltip) })) : [],
          keywords: Array.isArray(it.keywords) ? it.keywords.map(String) : [],
          actions: actions(it.actions),
        };
        if (it.subtitle) out.subtitle = String(it.subtitle);
        if (it.icon) out.icon = String(it.icon);
        if (it.section) out.section = String(it.section);
        if (it.detail) out.detail = { markdown: String(it.detail.markdown ?? ""), metadata: (it.detail.metadata ?? []).map((m) => ({ label: String(m.label), text: String(m.text), link: str(m.link) })) };
        return out;
      });
      model = { type: "list", items, isLoading: !!v.isLoading };
      if (v.searchPlaceholder) model.searchPlaceholder = String(v.searchPlaceholder);
      if (v.emptyText) model.emptyText = String(v.emptyText);
      if (typeof v.onSearchTextChange === "function") model.searchHandler = register(v.onSearchTextChange as Fn);
    } else if (view.type === "detail") {
      const v = view as DetailView;
      model = {
        type: "detail",
        markdown: String(v.markdown ?? ""),
        metadata: (Array.isArray(v.metadata) ? v.metadata : []).map((m) => ({ label: String(m.label), text: String(m.text), link: str(m.link) })),
        actions: actions(v.actions),
        isLoading: !!v.isLoading,
      };
      if (v.title) model.title = String(v.title);
    } else if (view.type === "form") {
      const v = view as FormView;
      if (typeof v.onSubmit !== "function") throw new TypeError("Form needs an onSubmit function");
      const fields: FormFieldModel[] = (Array.isArray(v.fields) ? v.fields : []).map((f) => {
        const type = ["text", "password", "textarea", "checkbox", "dropdown"].includes(f.type) ? f.type : "text";
        const field: FormFieldModel = { id: String(f.id), title: String(f.title ?? f.id), type, required: !!f.required, options: (f.options ?? []).map((o) => ({ value: String(o.value), title: String(o.title ?? o.value) })) };
        if (f.placeholder) field.placeholder = String(f.placeholder);
        if (f.default !== undefined) field.default = typeof f.default === "boolean" ? f.default : String(f.default);
        if (f.info) field.info = String(f.info);
        return field;
      });
      model = { type: "form", fields, submitHandler: register(v.onSubmit as Fn), submitTitle: str(v.submitTitle) ?? "Submit", isLoading: !!v.isLoading };
      if (v.description) model.description = String(v.description);
    } else {
      throw new TypeError(`Unknown view type: ${String((view as { type?: unknown }).type)}`);
    }
    handlers.set(depth, table);
    return model;
  }

  function closeFrom(depth: number) {
    for (const d of Array.from(handlers.keys())) if (d >= depth) handlers.delete(d);
    for (const d of Array.from(navGeneration.keys())) if (d >= depth) navGeneration.set(d, (navGeneration.get(d) ?? 0) + 1);
  }

  const renderAt = (depth: number, view: View, type: "render" | "push" = "render") => {
    try {
      send({ type, depth, view: serialize(view, depth) });
    } catch (err) {
      reportError(err);
    }
  };

  async function pushView(depth: number, factory: ViewFactory) {
    closeFrom(depth);
    const gen = (navGeneration.get(depth) ?? 0) + 1;
    navGeneration.set(depth, gen);
    let pushed = false;
    let early: View | undefined;
    const alive = () => navGeneration.get(depth) === gen;
    const nav: Navigation = {
      render(view) {
        if (!alive()) return;
        if (pushed) renderAt(depth, view);
        else early = view;
      },
      pop() {
        if (alive()) send({ type: "pop", depth });
      },
    };
    const view = (await factory(nav)) ?? early;
    if (!alive()) return;
    if (!view) throw new TypeError("Action.Push factory returned no view");
    pushed = true;
    renderAt(depth, view, "push");
  }

  function reportError(err: unknown) {
    const e = err instanceof Error ? err : new Error(String(err));
    send({ type: "error", message: e.message, stack: e.stack });
  }

  // --- public API -----------------------------------------------------------
  const opts = (o: unknown): Record<string, unknown> => (o && typeof o === "object" ? (o as Record<string, unknown>) : {});
  const Action = {
    OpenInBrowser: (url: string, o?: unknown): ActionDescriptor => ({ ...opts(o), kind: "openInBrowser", url }),
    CopyToClipboard: (text: string, o?: unknown): ActionDescriptor => ({ ...opts(o), kind: "copy", text }),
    Paste: (text: string, o?: unknown): ActionDescriptor => ({ ...opts(o), kind: "paste", text }),
    Push: (a: unknown, b?: unknown, c?: unknown): ActionDescriptor =>
      typeof a === "string" ? { ...opts(c), title: a, kind: "push", factory: b as ViewFactory } : { ...opts(b), kind: "push", factory: a as ViewFactory },
    Run: (title: string, handler: () => void | Promise<void>, o?: unknown): ActionDescriptor => ({ ...opts(o), title, kind: "run", handler }),
  };
  const toastArgs = (a: unknown, message?: string): ToastOptions => (typeof a === "string" ? { title: a, message } : (a as ToastOptions));
  const api: Record<string, unknown> = {
    List: (props: Omit<ListView, "type">): ListView => ({ ...props, type: "list" }),
    Detail: (props: Omit<DetailView, "type">): DetailView => ({ ...props, type: "detail" }),
    Form: (props: Omit<FormView, "type">): FormView => ({ ...props, type: "form" }),
    Action,
    showToast: async (a: unknown, message?: string) => {
      const t = toastArgs(a, message);
      await request("showToast", [t.style ?? "success", String(t.title ?? ""), t.message ?? null]);
    },
    showHUD: async (text: string) => {
      await request("showHUD", [String(text)]);
    },
    closeMainWindow: async () => {
      await request("closeMainWindow", []);
    },
    open: async (target: string) => {
      await request("open", [String(target)]);
    },
    getPreferenceValues: () => ({ ...preferences }),
    Clipboard: {
      copy: async (text: string) => {
        await request("clipboard.copy", [String(text)]);
      },
      paste: async (text: string) => {
        await request("clipboard.paste", [String(text)]);
      },
      read: async () => String((await request("clipboard.read", [])) ?? ""),
    },
    LocalStorage: {
      getItem: async (key: string) => (await request("storage.get", [String(key)])) ?? undefined,
      setItem: async (key: string, value: JsonValue) => {
        await request("storage.set", [String(key), value]);
      },
      removeItem: async (key: string) => {
        await request("storage.remove", [String(key)]);
      },
      allItems: async () => (await request("storage.all", [])) ?? {},
      clear: async () => {
        await request("storage.clear", []);
      },
    },
    environment,
    fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
  };

  // --- message handling -----------------------------------------------------
  function start(init: InitPayload) {
    preferences = init.preferences ?? {};
    Object.assign(environment, init.environment);
    (globalThis as Record<string, unknown>).__glideApi = api;
    const Module = nodeRequire("node:module") as { _resolveFilename(this: unknown, request: string, ...rest: unknown[]): string };
    const original = Module._resolveFilename;
    Module._resolveFilename = function (req: string, ...rest: unknown[]) {
      if (req === "@glide/api") return init.apiPath;
      return original.call(this, req, ...rest);
    };
    let fn: unknown;
    try {
      const mod = nodeRequire(init.commandPath) as { default?: unknown } | undefined;
      fn = mod && typeof mod === "object" && "default" in mod ? mod.default : mod;
      if (typeof fn !== "function") throw new TypeError(`${init.commandPath} must export a default function (module.exports = async function (ctx) {…})`);
    } catch (err) {
      reportError(err);
      return;
    }
    const ctx: CommandContext = {
      arguments: init.arguments ?? {},
      preferences: { ...preferences },
      environment: environment as Environment,
      render: (view: View) => renderAt(0, view),
    };
    Promise.resolve()
      .then(() => (fn as (c: CommandContext) => unknown)(ctx))
      .then(
        () => send({ type: "done" }),
        (err) => reportError(err),
      );
  }

  async function invoke(depth: number, handler: string, args: JsonValue[]) {
    const fn = handlers.get(depth)?.get(handler);
    if (!fn) return; // stale handler from an older render
    try {
      await (fn as (...a: JsonValue[]) => unknown)(...args);
    } catch (err) {
      await request("showToast", ["failure", errorMessage(err), null]).catch(() => undefined);
    }
  }

  function handle(msg: ParentMessage) {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "init") start(msg.init);
    else if (msg.type === "invoke") void invoke(msg.depth, msg.handler, Array.isArray(msg.args) ? msg.args : []);
    else if (msg.type === "closeView") closeFrom(msg.depth);
    else if (msg.type === "response") {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg.result);
    }
  }

  port.onMessage(handle);
  return { api, serialize, handle };
}

/** Source of runner.cjs: picks the transport (utilityProcess parentPort, or fork IPC) and starts the runtime. */
export function buildRunnerSource(): string {
  return [
    '"use strict";',
    "const pp = process.parentPort;",
    "const port = pp",
    "  ? { send: (m) => pp.postMessage(m), onMessage: (cb) => pp.on('message', (e) => cb(e.data)) }",
    "  : { send: (m) => process.send && process.send(m), onMessage: (cb) => process.on('message', cb) };",
    "process.on('uncaughtException', (e) => port.send({ type: 'error', message: String(e && e.message || e), stack: e && e.stack }));",
    "process.on('unhandledRejection', (e) => port.send({ type: 'error', message: String(e && e.message || e), stack: e && e.stack }));",
    `(${glideRuntime.toString()})(require, port);`,
    "",
  ].join("\n");
}
