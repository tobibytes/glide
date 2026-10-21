# Changelog

## 0.3.0

- **Menu bar:** extras for timers, system monitor, next meeting, clipboard and Glide Agent. Glide's own menu shows recent commands, running timers and focus status.
- **Clipboard 2.0:** image grid (⌘G), filters (⌘P), search inside copied images (OCR), Paste Stack, merge entries, edit before pasting, retention per type.
- **Extension store:** browse, install, update and uninstall extensions. Downloads are size- and SHA-256-verified and safely extracted.
- **Raycast compatibility:** menu-bar commands, background refresh, OAuth (PKCE), `AI.ask`, submenus, form drafts, Quick Look.
- **Quicklinks & Snippets 2.0:**
  - quicklinks: multiple arguments, open with an app, favicons
  - snippets: `{cursor}`, `{clipboard}`, `{date}` placeholders, nested snippets, rich text, keyword prefix
  - import from Raycast
- **Reminders and Finder:** "remind … tomorrow 9am"; copy path, Open Terminal Here, move, compress and open-with for the Finder selection.
- **Launcher:**
  - Tab chooser (Ask AI / Agent / fallback)
  - "Did you mean…"
  - Show more for long sections
  - Keep open after running a command (Settings → General)
- **Workflows:** 39 feature actions, including every text transform, Start Timer, Restore Layout, Run Automation and Convert.
- **Glide Agent 2.0:** conversations and history, ~17 more tools, plans before acting, undo, read-only mode, ⌘⏎ from the launcher, Save as Workflow.
- **Selected text:** reads selections in Chrome-family browsers and web pages, waits longer for busy apps, and explains why when it falls back to the clipboard.
- **Builds:** universal (Apple silicon + Intel) app, and GitHub Releases built automatically from version tags.
- **Quality:** headless test mode, visual/accessibility/performance suites, contrast fixes.
- New installs use `;sig` / `;shrug` snippet keywords so they don't fire inside words like "design".

## 0.2.0

- Automations, Glide Agent, window layouts and workspaces, screen text and QR, browser bookmarks and history, text transforms, process and port manager, themes, system monitor, settings sync.

## 0.1.0

- First release: launcher with fuzzy/frecency search, Shortcuts-style workflows, clipboard history, snippets, window management, AI commands, Raycast-style extensions, vim keys.
