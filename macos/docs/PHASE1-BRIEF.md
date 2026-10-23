# Phase 1 brief: native Glide feature sessions (read fully before writing code)

Native Glide is a full Swift rewrite of the Electron app in `../` (functional reference: `../src/main/features/<id>`, `../src/renderer/features/<id>`, `../src/shared/types.ts`, `../docs/FEATURES.md`). The Swift package lives in `macos/`:

- **GlideCore** (pure): model, search engine, `Feature`/`FeatureContext` protocols (`Sources/GlideCore/Feature/Feature.swift`), `Store` (reads and writes the user's existing data.json), themes, vim.
- **GlideSystem:** native services behind `SystemServices` protocols. Covers AX, selection, windows, menus, hotkeys, the key tap, paste, layouts, OCR, EventKit, Finder, Wi‑Fi, permissions and color picker. Headless fakes live in `Sources/GlideSystem/Headless`.
- **GlideUI** (SwiftUI): theme environment plus `Components/` (SearchField, list rows, sections, action panel, toast, footer, detail split). `FeatureUI` (`Sources/GlideUI/FeatureUI.swift`) adds `settingsPage`, `launcherView(_:payload:host:)` and `handleKey`.
- **GlideFeatures:** one folder per feature, `Sources/Features/<Name>/`, registered by adding ONE line to `Sources/Features/AllFeatures.swift` (re-read it right before editing; keep the phase-1 list alphabetical).
- **Glide** (app): launcher NSPanel (non-activating: the previous app stays frontmost, so selection and paste target it directly), settings window, menu bar, test server (`Sources/GlideApp/TestServer`).

Read `Feature.swift`, `FeatureUI.swift`, the GlideUI components, an existing feature (`Sources/Features/Applications`) and `Tests/Harness/` before starting.

## Rules

1. **Never touch the user's screen or session.** The user is working on this Mac.
   - Run the app only HEADLESS: `GLIDE_HEADLESS=1 GLIDE_USER_DATA=<fresh dir under $SCRATCH/>`, driven through the test server (`Tests/Harness/GlideDriver.swift` / `glide-driver.mjs`). Always kill what you start (SIGKILL fallback).
   - No windows on screen, no real hotkeys, no event taps, no posted keystrokes, no real pasteboard, no permission prompts.
   - Never run `open`, `osascript` or AppleScript, `screencapture`, `afplay`, or anything that activates apps.
2. **Never touch** `/Applications/Glide.app`, `~/Library/Application Support/Glide`, or the Electron app's source (`../src`, `../scripts`). Never run git. No new SwiftPM dependencies: implement what you need, or list a wished-for dependency in your report.
3. **Build in your own scratch dir** so parallel sessions don't fight over SwiftPM's lock: `swift build --scratch-path $SCRATCH/build-<your-session>`, and the same for `swift test`.
4. **Ownership:**
   - Own your folders.
   - For the shared targets (GlideCore, GlideSystem, GlideUI, GlideApp), make only small, additive changes. Re-read the file right before each edit and never reformat or rename existing API.
   - If you need a bigger shared change, write it to `macos/docs/requests/<session>.md` and work around it.
5. **Data compatibility:**
   - Use the same feature id as the Electron app for your settings bag (`Settings.features[<id>]`) and data dir (`<userData>/features/<id>/`).
   - Read existing files in the same formats, so a user's data carries over.
6. **Quality:**
   - Swift 6 strict concurrency, no force-unwraps on external data.
   - Keyboard-first: every view fully usable without a mouse, shortcuts shown, vim keys via the shared handling.
   - Native look: SF Symbols, materials, the theme environment.
   - Add Swift Testing tests for logic, plus a headless driver check for your UI flows.
7. **Final report:** files, evidence (test counts, driver output, snapshot paths), gaps, and any shared-file edits.
