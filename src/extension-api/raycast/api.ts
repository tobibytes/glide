/**
 * `@raycast/api` for Glide: host components (List, Grid, Detail, Form, ActionPanel, Action…),
 * navigation, toasts, clipboard, storage, preferences, environment and friends.
 *
 * Self-contained (serialised with Function.prototype.toString into the extension runner):
 * everything it needs comes in through its parameters.
 */
import type { MiniReact } from "./react";
import type { RaycastSerializer } from "./serialize";
import type { InitPayload, JsonValue, RequestMethod } from "../types";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface RaycastBridge {
  /** `onChunk` receives partial results of streaming requests (AI.ask). */
  request(method: RequestMethod, params: JsonValue[], onChunk?: (chunk: string) => void): Promise<unknown>;
  init(): InitPayload;
  nodeRequire(id: string): any;
}

export function createRaycastApi(mr: MiniReact, ser: RaycastSerializer, bridge: RaycastBridge): Record<string, any> {
  const React = mr.React;
  const H = mr.host;
  // Form field refs: focus()/reset() are applied by the launcher to the field with that id.
  const fieldHandle = (props: () => Record<string, any>) => ({
    focus: () => void bridge.request("form.field", ["focus", String(props().id ?? "")]).catch(() => undefined),
    reset: () => void bridge.request("form.field", ["reset", String(props().id ?? "")]).catch(() => undefined),
  });
  const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

  // --- host components ----------------------------------------------------------------------
  const metadataTree = (prefix: string) => {
    const M = H(`${prefix}.Metadata`);
    M.Label = H(`${prefix}.Metadata.Label`);
    M.Link = H(`${prefix}.Metadata.Link`);
    M.Separator = H(`${prefix}.Metadata.Separator`);
    M.TagList = H(`${prefix}.Metadata.TagList`);
    M.TagList.Item = H(`${prefix}.Metadata.TagList.Item`);
    return M;
  };
  const dropdownTree = (prefix: string, slots: string[] = []) => {
    const D = H(`${prefix}.Dropdown`, slots, fieldHandle);
    D.Item = H(`${prefix}.Dropdown.Item`);
    D.Section = H(`${prefix}.Dropdown.Section`);
    return D;
  };

  const List = H("List", ["searchBarAccessory", "actions"]);
  List.Item = H("List.Item", ["actions", "detail"]);
  List.Item.Detail = H("List.Item.Detail", ["metadata"]);
  List.Item.Detail.Metadata = metadataTree("List.Item.Detail");
  List.Section = H("List.Section");
  List.Dropdown = dropdownTree("List");
  List.EmptyView = H("List.EmptyView", ["actions"]);

  const Grid = H("Grid", ["searchBarAccessory", "actions"]);
  Grid.Item = H("Grid.Item", ["actions"]);
  Grid.Section = H("Grid.Section");
  Grid.Dropdown = dropdownTree("Grid");
  Grid.EmptyView = H("Grid.EmptyView", ["actions"]);
  Grid.Inset = { Small: "sm", Medium: "md", Large: "lg" };
  Grid.Fit = { Contain: "contain", Fill: "fill" };
  Grid.ItemSize = { Small: "small", Medium: "medium", Large: "large" };

  const Detail = H("Detail", ["metadata", "actions"]);
  Detail.Metadata = metadataTree("Detail");

  const Form = H("Form", ["actions", "searchBarAccessory"]);
  Form.TextField = H("Form.TextField", [], fieldHandle);
  Form.PasswordField = H("Form.PasswordField", [], fieldHandle);
  Form.TextArea = H("Form.TextArea", [], fieldHandle);
  Form.Checkbox = H("Form.Checkbox", [], fieldHandle);
  Form.DatePicker = H("Form.DatePicker", [], fieldHandle);
  Form.DatePicker.Type = { Date: "date", DateTime: "dateTime" };
  Form.DatePicker.isFullDay = (d: Date | null | undefined) => !!d && d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0;
  Form.Dropdown = dropdownTree("Form");
  Form.TagPicker = H("Form.TagPicker", [], fieldHandle);
  Form.TagPicker.Item = H("Form.TagPicker.Item");
  Form.FilePicker = H("Form.FilePicker", [], fieldHandle);
  Form.Separator = H("Form.Separator");
  Form.Description = H("Form.Description");
  Form.LinkAccessory = H("Form.LinkAccessory");

  const ActionPanel = H("ActionPanel");
  ActionPanel.Section = H("ActionPanel.Section");
  ActionPanel.Submenu = H("ActionPanel.Submenu");

  const Action = H("Action");
  for (const name of ["CopyToClipboard", "Paste", "OpenInBrowser", "Open", "OpenWith", "ShowInFinder", "Push", "SubmitForm", "Trash", "CreateSnippet", "CreateQuicklink", "ToggleQuickLook", "PickDate"])
    Action[name] = H(`Action.${name}`);
  Action.Style = { Regular: "regular", Destructive: "destructive" };
  Action.PickDate.Type = { Date: "date", DateTime: "dateTime" };

  const MenuBarExtra = H("MenuBarExtra");
  MenuBarExtra.Item = H("MenuBarExtra.Item");
  MenuBarExtra.Section = H("MenuBarExtra.Section");
  MenuBarExtra.Submenu = H("MenuBarExtra.Submenu");
  MenuBarExtra.Separator = H("MenuBarExtra.Separator");

  // --- icons, colours, images, keyboard -----------------------------------------------------
  const iconTable: Record<string, string> = {};
  for (const k of Object.keys(ser.ICON_GLYPHS)) iconTable[k] = `rc:${k}`;
  const Icon = new Proxy(iconTable, { get: (t, k) => (typeof k === "string" ? (t[k] ?? `rc:${k}`) : undefined) });
  const Color: Record<string, string> = { ...ser.COLORS };
  const Image = { Mask: { Circle: "circle", RoundedRectangle: "roundedRectangle" } };
  const sc = (modifiers: string[], key: string) => ({ modifiers, key });
  const Keyboard = {
    Shortcut: {
      Common: {
        Copy: sc(["cmd", "shift"], "c"),
        CopyDeeplink: sc(["cmd", "shift"], "c"),
        CopyName: sc(["cmd", "shift"], "."),
        CopyPath: sc(["cmd", "shift"], ","),
        Duplicate: sc(["cmd"], "d"),
        Edit: sc(["cmd"], "e"),
        MoveDown: sc(["cmd", "shift"], "arrowDown"),
        MoveUp: sc(["cmd", "shift"], "arrowUp"),
        New: sc(["cmd"], "n"),
        Open: sc(["cmd"], "o"),
        OpenWith: sc(["cmd", "shift"], "o"),
        Pin: sc(["cmd", "shift"], "p"),
        Refresh: sc(["cmd"], "r"),
        Remove: sc(["ctrl"], "x"),
        RemoveAll: sc(["ctrl", "shift"], "x"),
        ToggleQuickLook: sc(["cmd"], "y"),
      },
    },
  };

  // --- navigation ------------------------------------------------------------------------------
  const NavigationContext = React.createContext(null);
  function useNavigation() {
    const nav = React.useContext(NavigationContext);
    if (!nav) throw new Error("useNavigation must be used inside a command's view");
    return nav;
  }

  // --- requests --------------------------------------------------------------------------------
  const req = (m: RequestMethod, params: JsonValue[] = []) => bridge.request(m, params);

  // --- toasts / HUD / alerts ------------------------------------------------------------------
  const ToastStyle = { Success: "SUCCESS", Failure: "FAILURE", Animated: "ANIMATED" };
  const wireStyle = (s: unknown) => (s === "FAILURE" || s === "failure" ? "failure" : s === "ANIMATED" || s === "animated" ? "animated" : "success");
  let toastSeq = 0;
  /** Toast action handlers ("toast:<id>:primary|secondary"), invoked by the runtime like view handlers. */
  const toastHandlers = new Map<string, () => unknown>();
  class Toast {
    static Style = ToastStyle;
    readonly id = `t${++toastSeq}`;
    private _style: string;
    private _title: string;
    private _message?: string;
    private shown = false;
    private pending = false;
    primaryAction?: unknown;
    secondaryAction?: unknown;
    constructor(options: Record<string, any>) {
      this._style = options?.style ?? ToastStyle.Success;
      this._title = String(options?.title ?? "");
      this._message = options?.message === undefined ? undefined : String(options.message);
      this.primaryAction = options?.primaryAction;
      this.secondaryAction = options?.secondaryAction;
    }
    get style() {
      return this._style;
    }
    set style(v: string) {
      this._style = v;
      this.update();
    }
    get title() {
      return this._title;
    }
    set title(v: string) {
      this._title = String(v ?? "");
      this.update();
    }
    get message() {
      return this._message;
    }
    set message(v: string | undefined) {
      this._message = v === undefined || v === null ? undefined : String(v);
      this.update();
    }
    private update() {
      if (!this.shown || this.pending) return;
      this.pending = true;
      queueMicrotask(() => {
        this.pending = false;
        void this.show();
      });
    }
    private wireActions(): JsonValue {
      const out: JsonValue[] = [];
      for (const [slot, a] of [["primary", this.primaryAction], ["secondary", this.secondaryAction]] as const) {
        if (!isObj(a)) continue;
        const handler = `toast:${this.id}:${slot}`;
        toastHandlers.set(handler, () => a.onAction?.(this));
        out.push({ slot, title: String(a.title ?? (slot === "primary" ? "Open" : "More")), shortcut: ser.shortcutDisplay(a.shortcut) ?? null, handler });
      }
      return out;
    }
    async show() {
      this.shown = true;
      await req("showToast", [wireStyle(this._style), this._title, this._message ?? null, this.id, this.wireActions()]);
    }
    async hide() {
      this.shown = false;
      await req("toast.hide", [this.id]);
    }
  }

  async function showToast(a: unknown, title?: string, message?: string) {
    const opts = typeof a === "string" ? { style: a, title, message } : (a as Record<string, any>);
    const t = new Toast(opts ?? {});
    await t.show();
    return t;
  }

  const Alert = { ActionStyle: { Default: "DEFAULT", Destructive: "DESTRUCTIVE", Cancel: "CANCEL" } };
  async function confirmAlert(options: Record<string, any>) {
    const primary = options?.primaryAction ?? {};
    const dismiss = options?.dismissAction ?? {};
    const ok = (await req("confirmAlert", [
      {
        title: String(options?.title ?? "Are you sure?"),
        message: options?.message ? String(options.message) : null,
        primaryTitle: String(primary.title ?? "OK"),
        dismissTitle: String(dismiss.title ?? "Cancel"),
        destructive: primary.style === "DESTRUCTIVE",
      },
    ])) as boolean;
    try {
      if (ok) await primary.onAction?.();
      else await dismiss.onAction?.();
    } catch (err) {
      console.error(err);
    }
    return !!ok;
  }

  // --- clipboard ------------------------------------------------------------------------------
  const clipContent = (c: unknown): JsonValue => {
    if (isObj(c)) return { text: c.text === undefined ? null : String(c.text), html: typeof c.html === "string" ? c.html : null, file: typeof c.file === "string" ? c.file : null };
    return String(c ?? "");
  };
  const Clipboard = {
    copy: async (content: unknown) => void (await req("clipboard.copy", [clipContent(content)])),
    paste: async (content: unknown) => void (await req("clipboard.paste", [clipContent(content)])),
    clear: async () => void (await req("clipboard.clear")),
    readText: async () => {
      const t = (await req("clipboard.read")) as string | null;
      return t === null || t === "" ? undefined : t;
    },
    read: async () => {
      const t = (await req("clipboard.read")) as string | null;
      return { text: t ?? "" };
    },
  };

  // --- storage -----------------------------------------------------------------------------------
  const LocalStorage = {
    getItem: async (key: string) => {
      const v = await req("storage.get", [String(key)]);
      return v === null ? undefined : v;
    },
    setItem: async (key: string, value: unknown) => void (await req("storage.set", [String(key), value as JsonValue])),
    removeItem: async (key: string) => void (await req("storage.remove", [String(key)])),
    allItems: async () => ((await req("storage.all")) ?? {}) as Record<string, unknown>,
    clear: async () => void (await req("storage.clear")),
  };

  /** Synchronous key/value cache in the extension's support directory (like Raycast's Cache). */
  class Cache {
    private file: string;
    private data: Record<string, string>;
    private subs = new Set<(key: string | undefined, data: string | undefined) => void>();
    constructor(options?: { namespace?: string; capacity?: number }) {
      const fs = bridge.nodeRequire("node:fs");
      const path = bridge.nodeRequire("node:path");
      const ns = String(options?.namespace ?? "default").replace(/[^\w.-]/g, "_");
      const dir = path.join(environment.supportPath || bridge.nodeRequire("node:os").tmpdir(), ".cache");
      this.file = path.join(dir, `${ns}.json`);
      try {
        this.data = JSON.parse(fs.readFileSync(this.file, "utf8"));
        if (!isObj(this.data)) this.data = {};
      } catch {
        this.data = {};
      }
    }
    private save() {
      const fs = bridge.nodeRequire("node:fs");
      const path = bridge.nodeRequire("node:path");
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(this.file, JSON.stringify(this.data));
      } catch (err) {
        console.error("Cache write failed", err);
      }
    }
    get storageDirectory() {
      return bridge.nodeRequire("node:path").dirname(this.file);
    }
    get(key: string): string | undefined {
      return Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : undefined;
    }
    has(key: string) {
      return Object.prototype.hasOwnProperty.call(this.data, key);
    }
    get isEmpty() {
      return Object.keys(this.data).length === 0;
    }
    set(key: string, value: string) {
      this.data[key] = String(value);
      this.save();
      for (const s of this.subs) s(key, this.data[key]);
    }
    remove(key: string) {
      const had = this.has(key);
      delete this.data[key];
      this.save();
      for (const s of this.subs) s(key, undefined);
      return had;
    }
    clear(options?: { notifySubscribers?: boolean }) {
      this.data = {};
      this.save();
      if (options?.notifySubscribers !== false) for (const s of this.subs) s(undefined, undefined);
    }
    subscribe(fn: (key: string | undefined, data: string | undefined) => void) {
      this.subs.add(fn);
      return () => this.subs.delete(fn);
    }
  }

  // --- environment / preferences / launching -----------------------------------------------------
  const LaunchType = { UserInitiated: "userInitiated", Background: "background" };
  /** AI.ask → Glide's AI feature (main process). The promise also emits "data" chunks while streaming. */
  function ask(prompt: string, options?: Record<string, any>) {
    const { EventEmitter } = bridge.nodeRequire("node:events");
    const emitter = new EventEmitter();
    const signal = options?.signal as AbortSignal | undefined;
    const opts: JsonValue = { model: options?.model ? String(options.model) : null, creativity: options?.creativity === undefined ? null : String(options.creativity) };
    let p: Promise<string> = bridge.request("ai.ask", [String(prompt ?? ""), opts], (chunk: string) => emitter.emit("data", chunk)).then((r) => String(r ?? ""));
    if (signal) {
      p = new Promise<string>((resolve, reject) => {
        const onAbort = () => reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
        if (signal.aborted) return onAbort();
        signal.addEventListener("abort", onAbort, { once: true });
        p.then(resolve, reject);
      });
    }
    for (const m of ["on", "once", "off", "addListener", "removeListener", "emit"]) (p as any)[m] = (...a: unknown[]) => (emitter[m](...a), p);
    return p;
  }
  const AI = {
    Model: new Proxy({} as Record<string, string>, { get: (_t, k) => (typeof k === "string" ? k : undefined) }),
    Creativity: { None: "none", Low: "low", Medium: "medium", High: "high", Maximum: "maximum" },
    ask,
  };
  const BrowserExtension = { getContent: () => Promise.reject(new Error("BrowserExtension is not available in Glide")), getTabs: () => Promise.resolve([]) };
  const environment: Record<string, any> = {
    appearance: "dark",
    assetsPath: "",
    commandMode: "view",
    commandName: "",
    extensionName: "",
    isDevelopment: false,
    launchType: "userInitiated",
    raycastVersion: "1.100.0",
    ownerOrAuthorName: "",
    supportPath: "",
    textSize: "medium",
    theme: "dark",
    canAccess: (api: unknown) => (api === AI ? bridge.init().capabilities?.ai === true : api !== BrowserExtension),
  };

  const getPreferenceValues = () => ({ ...(bridge.init().preferences ?? {}) });
  const PopToRootType = { Default: "default", Immediate: "immediate", Suspended: "suspended" };

  async function launchCommand(options: Record<string, any>) {
    const name = String(options?.name ?? "");
    if (!name) throw new Error("launchCommand needs a command name");
    await req("launchCommand", [name, options.extensionName ? String(options.extensionName) : null, (options.arguments ?? {}) as JsonValue, (options.context ?? null) as JsonValue, options.type === "background" ? "background" : "userInitiated"]);
  }

  async function getSelectedText() {
    const text = (await req("selection.text")) as string | null;
    if (!text) throw new Error("Unable to get selected text from frontmost application");
    return text;
  }

  const appTarget = (app: unknown): string | null => (isObj(app) ? String(app.path ?? app.bundleId ?? app.name ?? "") || null : typeof app === "string" ? app : null);

  async function getApplications(dir?: string) {
    const fs = bridge.nodeRequire("node:fs");
    const path = bridge.nodeRequire("node:path");
    const roots = ["/Applications", "/System/Applications", "/System/Applications/Utilities", path.join(bridge.nodeRequire("node:os").homedir(), "Applications")];
    const out: Array<{ name: string; path: string; bundleId?: string }> = [];
    for (const r of roots) {
      let names: string[] = [];
      try {
        names = fs.readdirSync(r);
      } catch {
        continue;
      }
      for (const n of names) {
        if (!n.endsWith(".app")) continue;
        const app: { name: string; path: string; bundleId?: string } = { name: n.slice(0, -4), path: path.join(r, n) };
        try {
          // XML Info.plist only (binary plists are skipped); enough for most apps.
          const plist = fs.readFileSync(path.join(app.path, "Contents", "Info.plist"), "utf8");
          const m = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(plist);
          if (m) app.bundleId = m[1];
        } catch {
          /* no readable Info.plist */
        }
        out.push(app);
      }
    }
    void dir; // Glide cannot ask Launch Services which apps open a file: every app is returned.
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async function getFrontmostApplication() {
    const app = (await req("app.frontmost")) as Record<string, any> | null;
    if (!app) throw new Error("Could not determine the frontmost application");
    const out: Record<string, string> = { name: String(app.name ?? ""), path: String(app.path ?? "") };
    if (app.bundleId) out.bundleId = String(app.bundleId);
    return out;
  }

  async function getSelectedFinderItems() {
    const paths = (await req("finder.selection")) as string[] | null;
    return (Array.isArray(paths) ? paths : []).map((p) => ({ path: String(p) }));
  }

  // --- OAuth (PKCE; redirect through glide://oauth) -------------------------------------------
  const b64url = (buf: any) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  class TokenSetImpl {
    accessToken: string;
    refreshToken?: string;
    idToken?: string;
    expiresIn?: number;
    scope?: string;
    updatedAt: Date;
    constructor(o: Record<string, any>) {
      this.accessToken = String(o.accessToken ?? "");
      if (o.refreshToken) this.refreshToken = String(o.refreshToken);
      if (o.idToken) this.idToken = String(o.idToken);
      if (typeof o.expiresIn === "number") this.expiresIn = o.expiresIn;
      if (o.scope) this.scope = String(o.scope);
      this.updatedAt = new Date(o.updatedAt ?? Date.now());
    }
    isExpired() {
      // Like Raycast: a token is treated as expired 10 s early.
      return typeof this.expiresIn === "number" && this.updatedAt.getTime() + this.expiresIn * 1000 - 10_000 < Date.now();
    }
  }
  class PKCEClient {
    redirectMethod: string;
    providerName: string;
    providerIcon?: unknown;
    providerId: string;
    description?: string;
    constructor(options: Record<string, any> = {}) {
      this.redirectMethod = String(options.redirectMethod ?? "web");
      this.providerName = String(options.providerName ?? "Provider");
      this.providerIcon = options.providerIcon;
      this.providerId = String(options.providerId ?? options.providerName ?? "default").replace(/[^\w.-]/g, "_");
      if (options.description) this.description = String(options.description);
    }
    async authorizationRequest(options: Record<string, any>) {
      const crypto = bridge.nodeRequire("node:crypto");
      const codeVerifier = b64url(crypto.randomBytes(32));
      const codeChallenge = b64url(crypto.createHash("sha256").update(codeVerifier).digest());
      const state = b64url(crypto.randomBytes(16));
      const redirectURI = `glide://oauth?package_name=${encodeURIComponent(String(environment.extensionName || "extension"))}`;
      const endpoint = String(options?.endpoint ?? "");
      const params: Record<string, string> = {
        response_type: "code",
        client_id: String(options?.clientId ?? ""),
        redirect_uri: redirectURI,
        scope: String(options?.scope ?? ""),
        state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        ...(isObj(options?.extraParameters) ? options.extraParameters : {}),
      };
      return {
        codeChallenge,
        codeVerifier,
        state,
        redirectURI,
        toURL: () => {
          const u = new URL(endpoint);
          for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
          return u.toString();
        },
      };
    }
    async authorize(request: Record<string, any>) {
      const url = typeof request?.toURL === "function" ? request.toURL() : String(request?.url ?? "");
      let state = typeof request?.state === "string" ? request.state : "";
      if (!state) {
        try {
          state = new URL(url).searchParams.get("state") ?? "";
        } catch {
          /* checked by main */
        }
      }
      const res = (await req("oauth.authorize", [{ url, state, providerName: this.providerName, providerIcon: ser.toIconSource(this.providerIcon) ?? null, description: this.description ?? null }])) as Record<string, any>;
      return { authorizationCode: String(res?.code ?? "") };
    }
    async setTokens(t: Record<string, any>) {
      const o = isObj(t) && "access_token" in t
        ? { accessToken: t.access_token, refreshToken: t.refresh_token, idToken: t.id_token, expiresIn: t.expires_in, scope: t.scope }
        : t;
      const set = new TokenSetImpl({ ...o, updatedAt: Date.now() });
      await req("oauth.setTokens", [this.providerId, JSON.parse(JSON.stringify({ ...set, updatedAt: set.updatedAt.toISOString() }))]);
    }
    async getTokens() {
      const raw = (await req("oauth.getTokens", [this.providerId])) as Record<string, any> | null;
      return isObj(raw) && raw.accessToken ? new TokenSetImpl(raw) : undefined;
    }
    async removeTokens() {
      await req("oauth.removeTokens", [this.providerId]);
    }
  }

  const api: Record<string, any> = {
    // components
    List,
    Grid,
    Detail,
    Form,
    ActionPanel,
    Action,
    MenuBarExtra,
    // values
    Icon,
    Color,
    Image,
    Keyboard,
    Toast,
    Alert,
    LaunchType,
    PopToRootType,
    AI,
    BrowserExtension,
    environment,
    Clipboard,
    LocalStorage,
    Cache,
    // functions
    useNavigation,
    showToast,
    showHUD: async (title: string) => void (await req("showHUD", [String(title ?? "")])),
    confirmAlert,
    closeMainWindow: async () => void (await req("closeMainWindow")),
    popToRoot: async () => void (await req("popToRoot")),
    clearSearchBar: async () => void (await req("clearSearchBar")),
    open: async (target: string, application?: unknown) => void (await req("open", [String(target), appTarget(application)])),
    showInFinder: async (p: string) => void (await req("showInFinder", [String(p)])),
    trash: async (p: string | string[]) => void (await req("trash", (Array.isArray(p) ? p : [p]).map(String))),
    getPreferenceValues,
    openExtensionPreferences: async () => void (await req("openPreferences")),
    openCommandPreferences: async () => void (await req("openPreferences")),
    launchCommand,
    getSelectedText,
    getSelectedFinderItems,
    getApplications,
    getDefaultApplication: () => Promise.reject(new Error("getDefaultApplication is not supported in Glide yet")),
    getFrontmostApplication,
    updateCommandMetadata: async () => undefined,
    captureException: (e: unknown) => console.error(e),
    OAuth: {
      RedirectMethod: { Web: "web", App: "app", AppURI: "appURI" },
      PKCEClient,
      TokenSet: TokenSetImpl,
    },
    WindowManagement: { getActiveWindow: () => Promise.reject(new Error("WindowManagement is not supported in Glide yet")) },
    __glide: { NavigationContext, toastHandlers },
  };
  api.default = api;
  return api;
}
