# Glide (native macOS)

A full Swift rewrite of Glide, the keyboard-first launcher in `../` (Electron). Same bundle id
(`dev.glide.launcher`), same data directory (`~/Library/Application Support/Glide`: `data.json`, `usage.json`,
`features/<id>/`), same feature ids. A user's data and macOS privacy grants carry over.

- macOS 14+, Swift 6 (strict concurrency), SwiftPM only, no third-party dependencies.
- Agent app (`LSUIElement`): a menu bar item, a non-activating launcher panel and a Settings window.

## Layout

| Path | What |
| --- | --- |
| `Sources/GlideCore` | Pure Swift: model (lossless `data.json` / `usage.json`), search engine (fuzzy, frecency, ranking, sections), `Feature` / `FeatureContext`, `Store`, themes, vim. No AppKit. |
| `Sources/GlideSystem` | Native services behind the `SystemServices` protocols (AX, selection, windows, menus, hotkeys, key tap, paste, layouts, OCR, EventKit, Finder, Wi-Fi, permissions, color picker). Headless fakes in `Headless/`. |
| `Sources/GlideUI` | SwiftUI design system: theme environment, `Components/` (search field, rows, sections, action panel, toast, footer, detail split) and `FeatureUI`. |
| `Sources/Features/<Name>` | One folder per feature, registered in `Sources/Features/AllFeatures.swift`. |
| `Sources/GlideApp` | The `Glide` executable: launcher `NSPanel`, Settings window, menu bar, single instance, test server. |
| `Tests/` | Swift Testing suites, plus `Harness/` (the headless driver, in Swift and Node). |
| `scripts/test.sh` | Builds the app, then runs every test headless. |
| `scripts/build-app.sh` | Release build. Assembles and signs `build/Glide.app`. |

## Build and test

```sh
swift build                      # debug
scripts/test.sh                  # swift build && swift test (the E2E suites drive the real binary, headless)
scripts/build-app.sh             # universal (arm64 + x86_64) release .app → build/Glide.app (signed, verified; never installed or launched)
scripts/build-app.sh --arch arm64  # one slice only (faster); also x86_64
scripts/make-dmg.sh              # build/Glide.app → build/Glide-<version>.dmg (+ .sha256); `--arch …` builds first
```

Parallel work sessions each build in their own scratch directory:
`swift build --scratch-path <dir>`, `swift test --scratch-path <dir>`, `GLIDE_SCRATCH=<dir> scripts/build-app.sh`.

## Running

- **Normally:** open `build/Glide.app`. The launcher hotkey comes from Settings › General (default `Alt+Space`).
- **Headless:** nothing is ever put on screen. No hotkeys, taps, posted keys or real pasteboard. Side effects are logged as `[headless] …` lines.

  ```sh
  GLIDE_HEADLESS=1 GLIDE_USER_DATA=$(mktemp -d) .build/debug/Glide --test-server
  ```

  See [docs/TESTING.md](docs/TESTING.md).

## Docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) covers the modules, the `Feature` contract, the launcher model, data compatibility and conventions.
- [docs/TESTING.md](docs/TESTING.md) covers headless mode, the test-server protocol and the drivers.
- [docs/PHASE1-BRIEF.md](docs/PHASE1-BRIEF.md) holds the rules for feature sessions.
- `docs/requests/` holds requests from feature sessions for shared-target changes.
