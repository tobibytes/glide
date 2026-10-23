# Native Glide: architecture

Glide is a keyboard-first launcher. It shows a search panel over whatever app is frontmost, ranks items from many
features and runs their actions. This document covers the native (Swift) app. The Electron app in `../` is the
functional reference, mainly `../src/shared/types.ts`, `../src/main/features/<id>` and `../docs/FEATURES.md`.

## Modules (dependency order)

```
GlideCore  ←  GlideSystem  ←┐
     ↑                      ├─ GlideFeatures (Sources/Features/*)  ←  Glide (Sources/GlideApp)
     └─────── GlideUI    ←──┘
```

| Target | Rule |
| --- | --- |
| **GlideCore** | Pure Swift and Foundation only: no AppKit, no SwiftUI. Contains the model, `Store`, engine, `Feature`/`FeatureContext`, the `SystemServices` protocols, themes and vim. All of it can be unit-tested without a window server. |
| **GlideSystem** | The OS. It implements the `SystemServices` protocols with AppKit, AX, Carbon, EventKit, Vision, CoreWLAN and CoreLocation (`Native/`). It also holds the headless fakes (`Headless/`) and `SystemServicesFactory.live(...)` / `.headless(log:)`. |
| **GlideUI** | SwiftUI design system. It contains the `GlideTheme` environment, `Components/` and the `FeatureUI` protocol. It does not depend on GlideSystem. |
| **GlideFeatures** | One folder per feature (`Sources/Features/<Name>/`). It is registered in `AllFeatures.make()` with one line, and phase-1 features are listed alphabetically. |
| **Glide** | The app shell. It contains the lifecycle, the launcher panel and controller, the Settings window, the menu bar item, single-instance handling, glide:// URLs and the test server. |

## The Feature contract

The contract is defined in `Sources/GlideCore/Feature/Feature.swift`, with UI in `Sources/GlideUI/FeatureUI.swift`.
A feature is one `@MainActor` class that adopts `Feature`, and `FeatureUI` too if it has views or a settings page.

| Member | Contract |
| --- | --- |
| `id` | Must equal the Electron feature id. The id is the settings bag key (`settings.features[id]`), the data dir (`<userData>/features/<id>/`), the item-id prefix and the view-id prefix (`"<id>.<name>"`). |
| `start(context:)` | Called once at launch, after every feature exists. It must not block: start long work (scans, file loads) in a `Task`, then call `context.refreshCatalogue()`. Keep `context` **weak**, because the host owns it. |
| `stop()` | Called at quit. Flush files and cancel tasks here. |
| `items()` | Static catalogue items. It is called on every catalogue rebuild (at start, on a `data.json` change, or on `refreshCatalogue()`), so it must be cheap: return cached values. Set `item.feature = id`; the registry stamps it if missing. |
| `dynamicItems(for:)` | Per-keystroke items, such as the calculator, conversions and emoji. It must finish within `dynamicItemsBudget` (default 60 ms). Late results are dropped, so check `Task.isCancelled` and `query.deadline`. Return `[]` quickly for queries that do not concern the feature. |
| `actions(for:)` | Actions for items the feature owns. The **first action is primary (⏎)**. The action with shortcut `"⌘⏎"` is secondary. Other shortcuts (`"⇧⌘C"`, `"⌃X"`) work directly from the list. Use SF Symbol names for `icon`. Action ids starting with `copy`/`paste`/`delete`/`remove` are what vim `y`/`p`/`x` find. The launcher appends the generic actions (Favorite, Alias, Hotkey) itself. |
| `run(action:on:modifiers:)` | Performs the action and returns an `ActionResult`. `.hide(message:)` is the normal "done" result, and the launcher applies `keepOpenAfterRun` itself. `.stay(message:)` keeps the launcher open and refreshes it. `.pushView(id, payload:)` opens a view. `.openSettings(page:)` opens a settings page. `.error(msg)` shows an error toast. |
| `invoke(method:args:)` | A JSON RPC surface for other features (`context.callFeature`) and for the test channel (`{"cmd":"invoke"}`). Expose test hooks here, and throw `FeatureError.unknownMethod` otherwise. |
| `FeatureUI.settingsPage` | A `SettingsPage(id: <feature id>, title:, symbol:, order:) { AnyView(...) }` shown in the Settings sidebar. |
| `FeatureUI.launcherView(_:payload:host:)` | The SwiftUI view for a pushed view id. Use `host` (`LauncherViewHost`) for the query, placeholder, push, pop, close, toast and footer. |
| `FeatureUI.handleKey(_:view:)` | Keys while the feature's view is on top, before the launcher's default handling. Return `true` when the key is consumed. A feature with its own list can adopt `FeatureCommandHandling` to receive the shared vim commands (j/k, gg/G, ⏎, ⌘K …). |

`FeatureContext` is the feature's only handle on the host (`Sources/GlideApp/Shell/HostContext.swift`). It provides:

- `store`
- `services` (`SystemServices`)
- `dataDirectory()`
- `settings(defaults:)` / `setSettings(_:)`
- `refreshCatalogue()`
- `show`/`hide`/`push`
- `openSettings`
- `toast`
- `registerHotkey(key:accelerator:handler:)`
- `executeItem`
- `search`
- `findItem`
- `callFeature`
- `log`

Features never touch AppKit globals for things a service covers. For example, they use `services.pasteboard`
rather than `NSPasteboard.general`, and `services.paste` rather than posting ⌘V. This lets them run unchanged in
headless mode.

### Shared APIs added at integration

| API | Use |
| --- | --- |
| `FeatureContext.recordEffect(kind:detail:)` | Side effects without a SystemServices API. Headless: lands in the side-effect log (`[headless] …` and `headless/effects`). Context-free helpers use `SideEffectLog.recordShared`. |
| `FeatureContext.setStatusTitle(_:)` | Text next to the Glide menu-bar icon (Timers' countdown). `StatusTitleRouting.claim` lets Menu Bar show it on its Timers extra instead. Headless: `status-title` effect. |
| `FeatureContext.executeItem` | Returns the item's real `ActionResult`. |
| `LauncherViewHost.setTitle(_:)` / `FeatureUI.viewTitle(_:payload:)` | Footer context title of a pushed view. Default: the pushing item's title, else the feature title. Never the raw view id. Test state: `contextTitle`. |
| push payload `"query"` | Pre-fills the pushed view's search field. `LauncherViewHost.setQuery` changes it later. |
| `LauncherViewHost.viewStack` | Ids of the pushed views, bottom → top. |
| `SettingsPage(onRoute:)` | Receives the sub-route of `<page>/<route>` or `<page>#<route>` (`workflows/<id>`, `snippets/<id>`, `automations#new`), also in headless runs and settings snapshots. |
| `PasteboardService.imagePNG/setImagePNG/fileURLs/setFileURLs` | Image and file pasteboard contents. Headless fake: `pasteboard-image` and `pasteboard-files` effects. |
| `ItemIcon.url(_:)` (kind `"url"`) | `data:` and `file:` images. http(s) favicons are fetched only in the live app (`FaviconCache.networkAllowed`). |
| ⌘⏎ in the root search | `agent/openFromLauncher {query}`. Applies when the selected row is a fallback, there is no selection, or the row has no ⌘⏎ action of its own. Otherwise the row's ⌘⏎ wins. Agent settings can turn it off. |

The search engine's inline argument ("g electron") does not apply when the whole query is the start of some item's
title, so "search snippets" opens Search Snippets rather than "Search Bookmarks" with the argument "snippets". An
exact alias still wins.

## Launcher

| Component | Role |
| --- | --- |
| **`LauncherPanel`** (`NSPanel`) | Uses `.nonactivatingPanel`, `.floating`, `canJoinAllSpaces` and `fullScreenAuxiliary`. Glide never becomes the active app while the panel is shown, so the user's app stays frontmost: selection reading and paste-back target it directly. The panel and its hosting view are created at launch. Showing it is a layout plus `makeKeyAndOrderFront` (well under 1 ms of AppKit work). It opens on the screen with the mouse, with its top edge 22% down from the top of the screen, and grows downward. In headless mode the panel overrides every order-front and make-key call into a no-op. |
| **`LauncherController`** (`@Observable`) | The UI-agnostic brain: catalogue → `SearchEngine`, query, rows and sections, selection, the vim state machine, the action panel, the argument mode, the view stack, toasts, hotkey registration and usage recording. Everything the test server drives goes through it. |
| **`LauncherView`** (SwiftUI) | Renders the search field, sections and rows, the action panel, the pushed views (`FeatureUI.launcherView`), the toast and the footer. It uses the theme environment, `VibrancyBackground` (`.hudWindow` material; opaque in headless mode so snapshots are deterministic) and SF Symbols throughout. |

Keyboard (all keys go through `LauncherController.handleKey` before the text field sees them):

| Keys | Behaviour |
| --- | --- |
| ↑/↓, ⌃J/⌃K, ⌃N/⌃P | Move the selection |
| ⌃D/⌃U | Move the selection by half a page |
| ⌥↑/⌥↓ | Jump between sections |
| ⏎ / ⌘⏎ | Run the primary / secondary action |
| ⌘K | Open the action panel. Type to filter it, use ↑/↓ or ⌃J/⌃K to move, ⏎ to run, Esc/⌫ to close. Action shortcuts also work from the panel. |
| ⌘1–⌘9 | Run the n-th row |
| Tab | On an item that `acceptsArgument`, enter argument mode (the field becomes the argument; Esc or ⌫ on empty leaves it). Otherwise run the item. |
| Esc (vim off) | Clears the query. If the query is empty, pops the view. At the root, hides. |
| Esc (vim on) | INSERT → NORMAL. In NORMAL, Esc hides. NORMAL keys: `j k gg G {count} ⌃D ⌃U l/⏎ h/⌫ (pop / clear) i a I / x(twice) y p q`. The panel opened from NORMAL also navigates with j/k/l/h. Show, push and pop always land in INSERT. |
| Idle | If the launcher is shown again after 90 s idle, it resets to the root with an empty query (pop-to-root). |
| Blur | With `hideOnBlur`, the panel hides when it resigns key. |

The launcher hotkey is `settings.hotkey`, an Electron accelerator such as `Alt+Space`. `registerHotkeys()` registers
it together with per-item hotkeys, workflow hotkeys and feature hotkeys, through `services.hotkeys` (Carbon hot keys
plus a modifier-only tap; see `GlideSystem/Native/Hotkeys.swift`). Any `data.json` change re-registers them, and
the Settings › General recorder writes canonical accelerators.

**Shell:**

- **`StatusItemController`**: menu bar item (`sparkle.magnifyingglass`) with Open, Settings… and Quit.
- **`SettingsWindowController`**: `NavigationSplitView` with General (hotkey recorder, theme, vim, blur, keep-open, calculator, section limit), Appearance (theme presets, density, vibrancy, animations), one page per `FeatureUI.settingsPage` sorted by `order`, and About.
- **`SingleInstance`**: an `flock` on `<userData>/glide-native.lock`. A second launch posts a distributed notification that shows the running instance's launcher, then exits. The lock is per data directory, so a headless test instance never conflicts with the user's app.
- **`glide://`**: `glide://settings/<page>`. Anything else shows the launcher. Phase 1 can add routes.

## Data compatibility

- `Store` (GlideCore) reads and writes `<userData>/data.json` and `usage.json` in the Electron formats.
  - Every model type decodes through `LosslessReader` and encodes through `LosslessWriter`. Unknown keys are kept in `extra` and written back, so a round trip is byte-for-byte equivalent in content (tests: `ModelStoreTests`).
  - Decoding is tolerant. A field with the wrong type falls back to its default instead of failing the file.
  - Writes are debounced (250 ms), atomic and serialised on one queue. `flush()` runs on quit.
- `<userData>` is `GLIDE_USER_DATA` if set, otherwise `~/Library/Application Support/Glide`. Both apps use the same directory.
- Feature settings live in `settings.features[<id>]`. Feature files live in `<userData>/features/<id>/`, in the Electron file formats.

## Conventions (see PHASE1-BRIEF.md)

- Swift 6 language mode and strict concurrency. Features and UI run on `@MainActor`. No force-unwraps on external data.
- Keyboard-first: every view is usable without a mouse, shortcuts are shown (as keycaps in rows and the action panel), and vim keys go through the shared handling.
- Native look: SF Symbols, materials and the `GlideTheme` environment (`@Environment(\.glideTheme)`). Colors never come from hard-coded values in feature views.
- Every OS side effect goes through a `SystemServices` protocol that has a headless fake, which records a `[headless] <kind> <detail>` line.
- Tests: Swift Testing for logic, plus a headless driver check for UI flows (docs/TESTING.md).
- Shared targets accept only small, additive edits. Larger requests go to `docs/requests/<session>.md`.
