import { shell } from "electron";
import type { ExecuteResult } from "@shared/ipc";
import type { MenuItemInfo } from "../../native/helper";
import type { FeatureContext, FeatureModule } from "../types";

const ACCESSIBILITY_PANE = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";

/** What the "menus.search" view receives from list(). */
export interface MenuListResult {
  app: { name: string; pid: number } | null;
  items: MenuItemInfo[];
  error?: string;
  needsAccessibility?: boolean;
}

let ctx: FeatureContext | null = null;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const toPid = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined);

async function list(pidArg: unknown): Promise<MenuListResult> {
  const c = ctx;
  if (!c?.helper.available()) return { app: null, items: [], error: "Menu search needs the Glide helper, which is not running." };
  const perms = await c.helper.call("permissions.status").catch(() => null);
  if (perms && !perms.accessibility) {
    return { app: null, items: [], needsAccessibility: true, error: "Glide needs Accessibility permission to read other apps' menus." };
  }
  let pid = toPid(pidArg);
  let name = "";
  if (!pid) {
    const front = await c.helper.call("app.frontmost");
    if (!front) return { app: null, items: [], error: "No application to read menus from." };
    pid = front.pid;
    name = front.name;
  }
  const items = await c.helper.call("menus.list", { pid });
  return { app: { name, pid }, items };
}

async function press(pidArg: unknown, pathArg: unknown): Promise<ExecuteResult> {
  const c = ctx;
  if (!c) return { ok: false, error: "Menu search is not ready" };
  const path = Array.isArray(pathArg) && pathArg.every((p) => typeof p === "string") ? (pathArg as string[]) : null;
  if (!path || path.length < 2) return { ok: false, error: "Invalid menu item" };
  // Hide first so the target app is frontmost when the menu action runs.
  c.hideLauncher();
  await sleep(120);
  const r = await c.helper.call("menus.press", { pid: toPid(pidArg), path });
  return r.ok ? { ok: true, hide: true } : { ok: false, hide: true, error: r.error };
}

export const feature: FeatureModule = {
  id: "menus",
  start(c) {
    ctx = c;
  },
  stop() {
    ctx = null;
  },
  items: () => [
    {
      id: "menus.search",
      kind: "command",
      title: "Search Menu Items",
      subtitle: "Menu Bar",
      icon: { kind: "symbol", value: "☰" },
      keywords: ["menu", "menu bar", "menubar", "commands", "actions", "shortcuts"],
      feature: "menus",
      kindLabel: "Menu",
    },
  ],
  actions: () => [
    { id: "open", title: "Search Menu Items", icon: "☰" },
    { id: "open-accessibility", title: "Open Accessibility Settings", icon: "🔐" },
  ],
  async runAction(_item, actionId) {
    if (actionId === "open-accessibility") {
      await shell.openExternal(ACCESSIBILITY_PANE);
      return { ok: true, hide: true };
    }
    // Capture the target now: once the view is open, Glide stays frontmost.
    const front = ctx?.helper.available() ? await ctx.helper.call("app.frontmost").catch(() => null) : null;
    return { ok: true, view: { id: "menus.search", props: front ? { pid: front.pid, appName: front.name } : {} } };
  },
  methods: {
    list: (pid: unknown) => list(pid),
    press: (pid: unknown, path: unknown) => press(pid, path),
    openAccessibilitySettings: () => shell.openExternal(ACCESSIBILITY_PANE),
  },
};
