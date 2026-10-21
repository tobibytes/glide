/**
 * Raycast compatibility services that live in main: menu-bar commands (MenuBarExtra → status items),
 * background `interval` launches, OAuth (PKCE redirect through glide://oauth, encrypted tokens),
 * AI.ask, and the frontmost-app / Finder-selection helpers. Electron-free: everything the feature
 * owns (helper, settings, shell, menu bar) is injected so this is unit-testable.
 */
import type { ExecuteResult } from "@shared/ipc";
import type { JsonValue, RequestMethod, ViewModel } from "../../../extension-api/types";
import type { MenuBarHandle, MenuBarItemSpec } from "../../menubar";
import type { AiAsker } from "./ai-bridge";
import { BackgroundScheduler, backgroundKey } from "./background";
import type { CommandManifest } from "./manifest";
import { menuBarErrorSpec, menuBarId, menuBarSpec } from "./menubar-ext";
import { OAuthFlows, type OAuthTokenStore } from "./oauth";
import type { ExtensionRegistry } from "./registry";
import type { SessionEvent, SessionInfo, SessionManager } from "./sessions";

export type LaunchType = "userInitiated" | "background";

export interface LaunchOptions {
  launchType: LaunchType;
  args?: Record<string, string>;
  launchContext?: JsonValue;
}

export interface CompatDeps {
  sessions(): SessionManager;
  registry(): ExtensionRegistry;
  /** Start a command (index.ts runCommand); resolves when a no-view command finished. */
  launch(ext: string, command: string, opts: LaunchOptions): Promise<ExecuteResult & { sessionId?: string }>;
  /** Per-command background toggles ("<ext>/<command>" → on). */
  getBackground(): Record<string, boolean>;
  setBackground(next: Record<string, boolean>): void;
  registerMenuBarItem(spec: MenuBarItemSpec): MenuBarHandle;
  emit(event: SessionEvent): void;
  openView(view: { id: string; props: Record<string, unknown> }): void;
  openExternal(url: string): Promise<void>;
  helperCall(method: "app.frontmost" | "finder.selection"): Promise<unknown>;
  tokens: OAuthTokenStore;
  ai: AiAsker;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** Headless tests: shorten every interval to at most this many ms. */
  intervalCapMs?: number;
  log(...args: unknown[]): void;
}

export interface BackgroundCommandState {
  ext: string;
  extTitle: string;
  command: string;
  title: string;
  mode: CommandManifest["mode"];
  interval?: string;
  enabled: boolean;
  /** menu-bar: a status item is registered right now. */
  active: boolean;
  runs: number;
}

const isObj = (v: unknown): v is Record<string, JsonValue> => !!v && typeof v === "object" && !Array.isArray(v);
const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

interface MenuBarSlot {
  key: string;
  sessionId: string | null;
  handle: MenuBarHandle | null;
  title: string;
}

export class RaycastCompat {
  readonly flows = new OAuthFlows();
  private readonly scheduler: BackgroundScheduler;
  /** Active menu-bar commands by "<ext>/<command>". */
  private readonly menus = new Map<string, MenuBarSlot>();
  private readonly aborts = new Map<string, Set<AbortController>>();

  constructor(private readonly deps: CompatDeps) {
    this.scheduler = new BackgroundScheduler({
      run: (key) => this.runScheduled(key),
      setTimer: deps.setTimer,
      clearTimer: deps.clearTimer,
      log: deps.log,
    });
  }

  // --- background launches & menu-bar lifecycle ------------------------------------------------

  private command(key: string): { ext: string; cmd: CommandManifest; extTitle: string } | null {
    const i = key.indexOf("/");
    const ext = this.deps.registry().get(key.slice(0, i));
    const cmd = ext?.enabled ? ext.manifest?.commands.find((c) => c.name === key.slice(i + 1)) : undefined;
    return ext?.manifest && cmd ? { ext: ext.name, cmd, extTitle: ext.manifest.title } : null;
  }

  /** Commands that can run in the background (menu-bar, or no-view with an interval). */
  private candidates(): Array<{ key: string; ext: string; extTitle: string; cmd: CommandManifest }> {
    const out: Array<{ key: string; ext: string; extTitle: string; cmd: CommandManifest }> = [];
    for (const e of this.deps.registry().list()) {
      if (!e.enabled || !e.manifest) continue;
      for (const cmd of e.manifest.commands)
        if (cmd.mode === "menu-bar" || (cmd.mode === "no-view" && cmd.intervalMs)) out.push({ key: backgroundKey(e.name, cmd.name), ext: e.name, extTitle: e.manifest.title, cmd });
    }
    return out;
  }

  aiAvailable(): boolean {
    try {
      return this.deps.ai.available();
    } catch {
      return false;
    }
  }

  isEnabled(key: string): boolean {
    return this.deps.getBackground()[key] === true;
  }

  /** Re-derive schedules and status items from the installed set and the toggles. */
  sync() {
    const enabled = this.deps.getBackground();
    const list = this.candidates();
    const cap = this.deps.intervalCapMs;
    this.scheduler.sync(list.filter((c) => enabled[c.key] && c.cmd.intervalMs).map((c) => ({ key: c.key, intervalMs: cap ? Math.min(cap, c.cmd.intervalMs!) : c.cmd.intervalMs! })));
    const wanted = new Set(list.filter((c) => c.cmd.mode === "menu-bar" && enabled[c.key]).map((c) => c.key));
    for (const key of Array.from(this.menus.keys())) if (!wanted.has(key)) this.deactivateMenu(key);
    for (const key of wanted) if (!this.menus.has(key)) void this.startMenu(key, "background");
  }

  /** Turn background refresh / the status item of a command on or off (an explicit user action). */
  setEnabled(ext: string, command: string, on: boolean) {
    const key = backgroundKey(ext, command);
    const next = { ...this.deps.getBackground() };
    if (on) next[key] = true;
    else delete next[key];
    this.deps.setBackground(next);
    this.sync();
  }

  /**
   * Called after the user ran a command: Raycast activates interval and menu-bar commands on their
   * first launch (call it after the menu-bar session started, so sync() does not start a second one).
   */
  userLaunched(ext: string, cmd: CommandManifest) {
    if (cmd.mode !== "menu-bar" && !cmd.intervalMs) return;
    const key = backgroundKey(ext, cmd.name);
    if (this.isEnabled(key)) return;
    this.deps.setBackground({ ...this.deps.getBackground(), [key]: true });
    this.sync();
  }

  state(): BackgroundCommandState[] {
    return this.candidates().map((c) => ({
      ext: c.ext,
      extTitle: c.extTitle,
      command: c.cmd.name,
      title: c.cmd.title,
      mode: c.cmd.mode,
      interval: c.cmd.interval,
      enabled: this.isEnabled(c.key),
      active: !!this.menus.get(c.key)?.handle,
      runs: this.scheduler.runs.get(c.key) ?? 0,
    }));
  }

  private async runScheduled(key: string) {
    const found = this.command(key);
    if (!found) return;
    if (found.cmd.mode === "menu-bar") return void (await this.startMenu(key, "background"));
    const res = await this.deps.launch(found.ext, found.cmd.name, { launchType: "background" });
    if (!res.ok) this.deps.log(`background ${key}: ${res.error ?? "failed"}`);
  }

  /** (Re)start a menu-bar command; its previous process is replaced, its status item kept until the new render. */
  private async startMenu(key: string, launchType: LaunchType) {
    const found = this.command(key);
    if (!found) return;
    const slot = this.menus.get(key) ?? { key, sessionId: null, handle: null, title: found.cmd.title };
    this.menus.set(key, slot);
    const res = await this.deps.launch(found.ext, found.cmd.name, { launchType });
    if (!res.ok) {
      this.showMenu(slot, menuBarErrorSpec(found.cmd.title, res.error ?? "Could not start"));
      return;
    }
  }

  /** index.ts started a session for a menu-bar command. */
  menuSessionStarted(info: SessionInfo) {
    const key = backgroundKey(info.extName, info.commandName);
    const slot = this.menus.get(key) ?? { key, sessionId: null, handle: null, title: info.commandTitle };
    const previous = slot.sessionId;
    slot.sessionId = info.id;
    this.menus.set(key, slot);
    this.deps.sessions().setKeepAlive(info.id, true);
    if (previous && previous !== info.id) this.deps.sessions().kill(previous);
  }

  private showMenu(slot: MenuBarSlot, spec: Omit<MenuBarItemSpec, "id">) {
    if (slot.handle) slot.handle.update(spec);
    else {
      const i = slot.key.indexOf("/");
      slot.handle = this.deps.registerMenuBarItem({ id: menuBarId(slot.key.slice(0, i), slot.key.slice(i + 1)), ...spec });
    }
  }

  private deactivateMenu(key: string) {
    const slot = this.menus.get(key);
    if (!slot) return;
    this.menus.delete(key);
    slot.handle?.remove();
    if (slot.sessionId) this.deps.sessions().kill(slot.sessionId);
  }

  /** A click in the status item's menu: run the handler, relaunching the command if its process ended. */
  private menuClick(key: string, sessionId: string, handler: string) {
    const slot = this.menus.get(key);
    if (slot && slot.sessionId === sessionId && this.deps.sessions().invoke(sessionId, 0, handler, [{ type: "left-click" }])) return;
    void this.startMenu(key, "userInitiated");
  }

  /**
   * Session events from SessionManager. Returns true when consumed here (menu-bar renders never
   * reach the launcher).
   */
  onSessionEvent(e: SessionEvent): boolean {
    if (e.kind === "ended") {
      this.flows.cancelSession(e.sessionId);
      for (const c of this.aborts.get(e.sessionId) ?? []) c.abort();
      this.aborts.delete(e.sessionId);
      for (const slot of this.menus.values()) if (slot.sessionId === e.sessionId) slot.sessionId = null;
      return false;
    }
    const slot = Array.from(this.menus.values()).find((s) => s.sessionId === e.sessionId);
    if (!slot) return false;
    if ((e.kind === "render" || e.kind === "push") && e.view && (e.depth ?? 0) === 0) {
      const view: ViewModel = e.view;
      const sessionId = e.sessionId;
      if (view.type === "menubar") this.showMenu(slot, menuBarSpec(view, (h) => this.menuClick(slot.key, sessionId, h), slot.title));
      else this.showMenu(slot, menuBarErrorSpec(slot.title, view.type === "detail" ? view.markdown.replace(/^#.*\n+/, "").split("\n")[0] : "A menu-bar command must render <MenuBarExtra>"));
    }
    return true;
  }

  /** Extension uninstalled/disabled or app quitting. */
  stopAll() {
    this.scheduler.stopAll();
    for (const key of Array.from(this.menus.keys())) this.deactivateMenu(key);
  }

  scheduledKeys(): string[] {
    return this.scheduler.scheduled();
  }

  // --- requests from extension processes -----------------------------------------------------

  /** Returns `undefined` for methods it does not own. */
  async request(info: SessionInfo, method: RequestMethod, params: JsonValue[], stream: (chunk: string) => void): Promise<{ value: JsonValue | void } | undefined> {
    const p0 = params[0];
    switch (method) {
      case "app.frontmost": {
        const app = (await this.deps.helperCall("app.frontmost")) as Record<string, unknown> | null;
        if (!app) throw new Error("Could not determine the frontmost application");
        return { value: { name: String(app.name ?? ""), path: String(app.path ?? ""), bundleId: typeof app.bundleId === "string" ? app.bundleId : null } };
      }
      case "finder.selection": {
        let res: unknown;
        try {
          res = await this.deps.helperCall("finder.selection");
        } catch (err) {
          const msg = errMsg(err);
          if (/unknown method|not (available|supported|allowed)|headless|refused/i.test(msg)) throw new Error(`getSelectedFinderItems is not supported in this Glide build (${msg})`);
          throw new Error(`Finder selection is unavailable: ${msg}`);
        }
        const r = isObj(res) ? res : {};
        if (typeof r.error === "string" && r.error) throw new Error(r.error);
        return { value: Array.isArray(r.paths) ? r.paths.filter((x): x is string => typeof x === "string") : [] };
      }
      case "ai.ask": {
        if (!this.deps.ai.available()) throw new Error("Glide AI is not set up: add an Anthropic API key in Settings → AI");
        const o = isObj(params[1]) ? params[1] : {};
        const controller = new AbortController();
        const set = this.aborts.get(info.id) ?? new Set<AbortController>();
        set.add(controller);
        this.aborts.set(info.id, set);
        try {
          const text = await this.deps.ai.ask({ prompt: typeof p0 === "string" ? p0 : "", model: typeof o.model === "string" ? o.model : null, creativity: typeof o.creativity === "string" ? o.creativity : null, signal: controller.signal, onText: stream });
          return { value: text };
        } finally {
          set.delete(controller);
        }
      }
      case "oauth.authorize":
        return { value: await this.authorize(info, isObj(p0) ? p0 : {}) };
      case "oauth.getTokens":
        return { value: (this.deps.tokens.get(info.extName, String(p0 ?? "default")) as JsonValue | null) ?? null };
      case "oauth.setTokens":
        if (!isObj(params[1])) throw new Error("setTokens needs a token set");
        this.deps.tokens.set(info.extName, String(p0 ?? "default"), params[1]);
        return { value: null };
      case "oauth.removeTokens":
        this.deps.tokens.remove(info.extName, String(p0 ?? "default"));
        return { value: null };
      case "form.field": {
        const op = p0 === "reset" ? "reset" : "focus";
        const id = typeof params[1] === "string" ? params[1] : "";
        if (id) this.deps.emit({ sessionId: info.id, kind: "field", field: { op, id } });
        return { value: null };
      }
    }
    return undefined;
  }

  private async authorize(info: SessionInfo, o: Record<string, JsonValue>): Promise<JsonValue> {
    const { request, code } = this.flows.start({
      extName: info.extName,
      sessionId: info.id,
      url: String(o.url ?? ""),
      state: String(o.state ?? ""),
      providerName: String(o.providerName ?? "the provider"),
      providerIcon: typeof o.providerIcon === "string" ? o.providerIcon : undefined,
      description: typeof o.description === "string" ? o.description : undefined,
    });
    const prompt = { id: request.id, providerName: request.providerName, providerIcon: request.providerIcon, description: request.description };
    // View commands show the sign-in card over their view; others get a launcher view of their own.
    if (info.mode === "view") this.deps.emit({ sessionId: info.id, kind: "oauth", oauth: prompt });
    else this.deps.openView({ id: "extensions.oauth", props: { requestId: request.id, title: `Sign in with ${request.providerName}` } });
    try {
      return { code: await code };
    } finally {
      this.deps.emit({ sessionId: info.id, kind: "oauthDone", oauthId: request.id });
    }
  }

  /** The user pressed "Sign in": open the provider's page in the browser. */
  async openAuthorization(id: string) {
    const req = this.flows.get(id);
    if (!req) throw new Error("This sign-in request is no longer active");
    await this.deps.openExternal(req.url);
  }

  /** glide://oauth?… from the OS (open-url) or a test. */
  redirect(url: string): boolean {
    return this.flows.handleRedirect(url) !== null;
  }
}
