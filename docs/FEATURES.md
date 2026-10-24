# Features

Every feature is a module in `src/main/features/<id>` (main process) and `src/renderer/features/<id>` (UI). Type the command name in the launcher; most commands take an argument with **Tab**. In the app, **What Can Glide Do?** lists every command grouped by feature, plus things that work by just typing (`100 usd in eur`, `timer 25m tea`…).

## Core

| Feature | Commands and behaviour |
| --- | --- |
| **Search** | Apps, files (Spotlight plus Glide's own file index), system commands, workflows, quicklinks, snippets, extensions. Fuzzy, alias-aware and frecency-ranked. Favorites and per-item hotkeys. |
| **Workflows** | Settings → Workflows. 17 actions (apps, URLs, files, shell, AppleScript, HTTP, clipboard, type text, notifications, waits, prompts, variables, if/else, nested workflows) and `{{variables}}` such as `{{input}}`, `{{clipboard}}`, `{{result}}`, `{{date}}`. |
| **Automations** | *Create Automation*, *Automations*. Triggers: time of day and weekdays, every N minutes, app launched/quit/activated, Wi‑Fi changed, power and battery, display connected, folder changed (the new file is passed as input), Glide launched, hotkey. "Ask before running" defaults on for risky targets; rate-limited; 50-entry run log. |
| **Glide Agent** | *Ask Glide Agent*, or the "Ask Glide Agent" row under any search. Claude plans with 17 tools. Read-only tools run directly; anything that changes state asks first (⏎ run, ⌘⏎ run and stop asking, Esc cancel). At most 12 tool calls per request. |
| **Quick AI & AI Commands** | Ask AI from any query (Tab), AI Chat window, AI commands on the selected text (fix spelling, rewrite, summarize, translate, explain code…), custom commands with `{selection}` and `{argument}`. Uses your own Anthropic or OpenAI key (or any OpenAI-compatible server such as OpenRouter, Ollama or LM Studio), stored in the macOS keychain. |
| **Extensions** | *Manage Extensions*. Glide's descriptor API, or Raycast-style React extensions (List, Grid, Detail, Form, ActionPanel, hooks, `@raycast/utils`) through *Import Raycast Extension Folder…*. See [the extension guide](../src/extension-api/README.md). |
| **Script Commands** | Shell/Python/Node scripts with Raycast-style metadata comments. |

## Productivity

| Feature | Commands and behaviour |
| --- | --- |
| **Clipboard History** | Text, images, files, links and colors. Pin, search, paste. Skips password managers and transient data. |
| **Snippets** | Keyword expansion while typing anywhere (Input Monitoring), plus a paste-from-launcher list. |
| **Text Transforms** | *Transform Text* and root commands such as `uppercase` or `json pretty`. 34 transforms with a live preview. ⏎ pastes into the app, ⌘C copies, ⌘I chains. |
| **Conversions** | Inline: `5 ft 10 in to cm`, `100 usd in eur`, `5pm london in tokyo`, `days until dec 25`, `today + 3 weeks`. Currency rates are cached 6 hours and fetching can be turned off. |
| **Timers & Stopwatch** | `timer 25m tea`, presets, menu-bar countdown, laps. Timers survive restarts. |
| **Notes** | Quick notes with search, plus an always-on-top floating note. |
| **Focus** | Timed focus sessions from the launcher. |
| **Calendar** | Upcoming events; join meetings from the launcher. |
| **Quicklinks** | URL templates with `{query}`. |
| **Emoji & Symbols** | Search and paste. |

## Mac control

| Feature | Commands and behaviour |
| --- | --- |
| **Window Management** | Halves, quarters, thirds, maximize, center, restore, next display (Accessibility). |
| **Window Layouts & Workspaces** | *Save Window Layout*, *Restore Layout …*, *Create Workspace*. A workspace is a layout plus apps to open or quit (quitting always asks first), links, a focus session, a Shortcut and a note. Works across multiple displays. |
| **Menu Search** | Search and press any menu item of the frontmost app. |
| **Screen Text & QR** | *Capture Text*, *Scan QR Code*, and the same from a clipboard image. Apple Vision OCR, then copy, paste, translate or ask AI. |
| **Color Picker** | *Pick Color* (system loupe) and *Color History*. Copy as HEX, RGB, HSL, SwiftUI or CSS. Typing `#ff8800` shows a swatch. |
| **Process & Port Manager** | *Kill Process* (live, sorted by CPU), *Kill Port*, `port 3000`. System processes are protected and force-quit always asks. |
| **System Monitor** | Live CPU per core, memory, disk, battery, network and top processes with sparklines. `cpu` shows a one-line summary. |
| **Browser Bookmarks & History** | Chrome, Arc, Brave, Edge, Vivaldi, Opera, Firefox and Safari (with Full Disk Access). Read locally from temp copies; history is off by default. |
| **System Commands** | Sleep, lock, restart, empty trash, dark mode, hidden files, Dock auto-hide, restart Finder or Dock, volume, eject (destructive ones ask). |
| **Keyboard** | Global hotkey (⌘Space takeover from Spotlight), Hyper key on Caps Lock. |

## Look & sync

| Feature | Commands and behaviour |
| --- | --- |
| **Themes & Appearance** | *Switch Theme* (live preview while moving), 9 presets, accent, density, font size, radius, width, translucency, follow system light/dark. |
| **Sync & Backup** | Settings → Sync. Pick any synced folder: each Mac writes its own file, merges are deterministic, there's a conflict log and 10 rolling backups. Secrets are never synced. |
| **Vim mode** | Normal and insert modes, `j k gg G ⌃D ⌃U { } / counts`, in the launcher and feature views. |

## New in v0.3

| Feature | Commands and behaviour |
| --- | --- |
| **Menu Bar** | Settings → Menu Bar. Extras for timers, system monitor, next meeting, clipboard and agent. Glide's menu shows recent commands, running timers and focus status. |
| **Clipboard 2.0** | ⌘G toggles list or grid, ⌘P filters by type or source app. Text inside copied images is searchable. Paste Stack (FIFO/LIFO), merge, edit before pasting, plain-text paste, per-type retention. |
| **Extension Store** | *Store*. Browse by category, install after a third-party-code warning (size and SHA-256 verified, safe extraction), update, uninstall. The index lives in `store/index.json`. |
| **Quicklinks 2.0** | `{argument name="q" default="…" options="a,b"}`, `{clipboard}`, `{selection}`, `{date offset="+1d"}`, `{uuid}`, open with a chosen app, favicons, import from bookmarks or Raycast. |
| **Snippets 2.0** | `{cursor}`, nested `{snippet name=…}`, rich text, keyword prefix (e.g. `;`), per-app exclusions, case-adaptive, Raycast import, *Search Snippets*. |
| **Reminders** | Type `remind <task> tomorrow 9am #list`; *My Reminders* shows overdue, today and upcoming. Access is asked only when you choose Grant Access. |
| **Finder** | Copy Path of Selection, Open Terminal Here, New File Here, Move Selection to…, Compress, Open With. |
| **Launcher** | Tab chooser (Ask AI, Agent or a fallback), "Did you mean…", result count, Show more, ↑ for recent searches. *Keep open after running a command* (Settings → General). |
| **Workflows** | 39 feature actions (all text transforms, Start Timer, Restore Layout, Run Automation, Convert…), plus "Run Glide Command". |
| **Glide Agent 2.0** | Conversations and history (⌘N, ⌘Y), ~17 more tools, a plan shown first, undo (⌘Z), read-only mode, ⌘⏎ from the launcher, Save as Workflow (⌘S). |
