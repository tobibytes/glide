/** Renderer side of every feature: launcher views, settings pages and window routes. */
import type { ComponentType } from "react";
import type { FeatureUI, ViewProps } from "./types";
import { ui as u_clipboard } from "./clipboard";
import { ui as u_keyboard } from "./keyboard";
import { ui as u_windows } from "./windows";
import { ui as u_menus } from "./menus";
import { ui as u_fallbacks } from "./fallbacks";
import { ui as u_emoji } from "./emoji";
import { ui as u_scripts } from "./scripts";
import { ui as u_notes } from "./notes";
import { ui as u_focus } from "./focus";
import { ui as u_calendar } from "./calendar";
import { ui as u_extensions } from "./extensions";
import { ui as u_ai } from "./ai";
import { ui as u_fileindex } from "./fileindex";
import { ui as u_app } from "./app";
import { ui as u_convert } from "./convert";
import { ui as u_color } from "./color";
import { ui as u_timers } from "./timers";
import { ui as u_automations } from "./automations";
import { ui as u_agent } from "./agent";
import { ui as u_layouts } from "./layouts";
import { ui as u_ocr } from "./ocr";
import { ui as u_browser } from "./browser";
import { ui as u_processes } from "./processes";
import { ui as u_sysmon } from "./sysmon";
import { ui as u_appearance } from "./appearance";
import { ui as u_transforms } from "./transforms";
import { ui as u_sync } from "./sync";

export const FEATURE_UIS: Record<string, FeatureUI> = { "clipboard": u_clipboard, "keyboard": u_keyboard, "windows": u_windows, "menus": u_menus, "fallbacks": u_fallbacks, "emoji": u_emoji, "scripts": u_scripts, "notes": u_notes, "focus": u_focus, "calendar": u_calendar, "extensions": u_extensions, "ai": u_ai, "fileindex": u_fileindex, "app": u_app };
Object.assign(FEATURE_UIS, { convert: u_convert, color: u_color, timers: u_timers });
Object.assign(FEATURE_UIS, { automations: u_automations, agent: u_agent, layouts: u_layouts, ocr: u_ocr, browser: u_browser, processes: u_processes, sysmon: u_sysmon, appearance: u_appearance, transforms: u_transforms, sync: u_sync });

// Finder selection commands and Apple Reminders (S8).
import { ui as u_finder } from "./finder";
import { ui as u_reminders } from "./reminders";
Object.assign(FEATURE_UIS, { finder: u_finder, reminders: u_reminders });
/** Resolve "<featureId>.<view>" to its component. */
export function resolveView(id: string): ComponentType<ViewProps> | undefined {
  const dot = id.indexOf(".");
  if (dot < 0) return undefined;
  return FEATURE_UIS[id.slice(0, dot)]?.views?.[id.slice(dot + 1)];
}

/** Resolve a window route "<featureId>/<name>" (from location.hash "#/<featureId>/<name>"). */
export function resolveWindow(route: string): ComponentType | undefined {
  const [featureId, name] = route.replace(/^[#/]+/, "").split("/");
  return featureId && name ? FEATURE_UIS[featureId]?.windows?.[name] : undefined;
}

export function settingsPages(): Array<{ id: string; title: string; icon: string; component: ComponentType }> {
  return Object.entries(FEATURE_UIS).flatMap(([id, ui]) => (ui.settingsPage ? [{ id, ...ui.settingsPage }] : []));
}
// Menu-bar mode (Settings → Menu Bar).
import { ui as u_menubar } from "./menubar";
Object.assign(FEATURE_UIS, { menubar: u_menubar });
// First-run onboarding window (#/onboarding/welcome).
import { ui as u_onboarding } from "./onboarding";
Object.assign(FEATURE_UIS, { onboarding: u_onboarding });
// Glide as an MCP server: Settings → MCP Server + the launcher confirmation view.
import { ui as u_mcpServer } from "./mcp-server";
Object.assign(FEATURE_UIS, { "mcp-server": u_mcpServer });
