/** Every feature module, in start order. Owners edit only their own folder. */
import type { FeatureModule } from "./types";
import { feature as f_clipboard } from "./clipboard";
import { feature as f_keyboard } from "./keyboard";
import { feature as f_windows } from "./windows";
import { feature as f_menus } from "./menus";
import { feature as f_fallbacks } from "./fallbacks";
import { feature as f_emoji } from "./emoji";
import { feature as f_scripts } from "./scripts";
import { feature as f_notes } from "./notes";
import { feature as f_focus } from "./focus";
import { feature as f_calendar } from "./calendar";
import { feature as f_extensions } from "./extensions";
import { feature as f_ai } from "./ai";
import { feature as f_fileindex } from "./fileindex";
import { feature as f_app } from "./app";
import { feature as f_convert } from "./convert";
import { feature as f_color } from "./color";
import { feature as f_timers } from "./timers";
import { feature as f_syscmds } from "./syscmds";
import { feature as f_automations } from "./automations";
import { feature as f_agent } from "./agent";
import { feature as f_layouts } from "./layouts";
import { feature as f_ocr } from "./ocr";
import { feature as f_browser } from "./browser";
import { feature as f_processes } from "./processes";
import { feature as f_sysmon } from "./sysmon";
import { feature as f_appearance } from "./appearance";
import { feature as f_transforms } from "./transforms";
import { feature as f_sync } from "./sync";

export const FEATURES: FeatureModule[] = [f_clipboard, f_keyboard, f_windows, f_menus, f_fallbacks, f_emoji, f_scripts, f_notes, f_focus, f_calendar, f_extensions, f_ai, f_fileindex, f_app];
// Raycast built-in gap: conversions, color picker, timers, extra system commands.
FEATURES.push(f_convert, f_color, f_timers, f_syscmds);
// Top-10 feature wave (one owner per folder).
FEATURES.push(f_automations, f_agent, f_layouts, f_ocr, f_browser, f_processes, f_sysmon, f_appearance, f_transforms, f_sync);
// Finder selection commands and Apple Reminders (S8).
import { feature as f_finder } from "./finder";
import { feature as f_reminders } from "./reminders";
FEATURES.push(f_finder, f_reminders);
// Menu-bar mode: status items, built-in extras and the Glide menu (started last; it reads other features).
import { feature as f_menubar } from "./menubar";
FEATURES.push(f_menubar);
