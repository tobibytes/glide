# Plan: a native Swift shell for Glide

Status: proposal. Do this after native hotkeys, native snippets and MCP have landed in the helper.

## Why

Glide's UI and features are about 70k lines of TypeScript/React. They are fine; the cost is Electron's shell:

- **Size:** the DMG is ~237 MB, almost all of it Chromium.
- **Memory:** ~760 MB RSS across processes after warm-up.
- **Window focus:** quirks like hide-on-blur races and panels that appear without key focus.
- **Native integration:** Chromium swallows SIGTERM, and safeStorage keychain prompts are tied to Electron's item names.

A common alternative shape for a macOS launcher:

- a native AppKit shell owns the windows, hotkeys and permissions;
- a WKWebView renders the React UI;
- a bundled Node process runs the backend.

The goal is to adopt that shape while keeping ~95% of Glide's code.

## Target architecture

```
┌──────────────── Glide.app (Swift, AppKit) ────────────────┐
│ NSPanel launcher (non-activating option, vibrancy)        │
│ settings / feature windows (NSWindow)                     │
│ hotkeys, event tap, AX, OCR, EventKit (today's helper)     │
│ WKWebView ×N ── WKScriptMessageHandlerWithReply ──┐        │
│ glide:// scheme handler serves dist/renderer       │        │
│ Keychain (SecItem) for secrets                     │        │
└───────────────────────────────┬───────────────────┼────────┘
            framed JSON / stdio │                   │ evaluateJavaScript (events)
┌───────────────────────────────┴───────────────────┴────────┐
│ Node (bundled, signed)  ← today's src/main minus Electron   │
│ engine, catalogue, features, workflows, agent, MCP, store   │
└────────────────────────────────────────────────────────────┘
```

## What moves where

| Today (Electron) | Native shell |
| --- | --- |
| `BrowserWindow` launcher/settings/feature windows | `NSPanel`/`NSWindow` + `WKWebView`; window routes stay `#/<feature>/<name>` |
| `src/preload` `window.glide` bridge (ipcRenderer) | Injected JS shim with the same `window.glide` API over `WKScriptMessageHandlerWithReply`, so the renderer is unchanged |
| `ipcMain.handle` channels | Same channel names, carried as framed JSON between Swift and Node |
| `globalShortcut`, `Tray`, `Notification`, `dialog`, `shell` | AppKit equivalents in Swift; Node calls them through a "host" request set |
| `safeStorage` | Keychain items owned by Glide.app; one-time migration that decrypts with Electron's key |
| `clipboard`, `nativeImage` | NSPasteboard and NSImage via host requests (the helper already does most of this) |
| `utilityProcess` (extensions) | `child_process` from Node; unchanged runtime |
| Swift helper process | Merged into the app binary, so one process owns all permissions |
| Headless test mode | `GLIDE_HEADLESS=1` keeps meaning: windows created offscreen / never ordered front, host requests faked |

## Phases

Each phase ships on its own and keeps all suites green.

1. **Abstract Electron in main** (TS only): route every Electron API through a `host` interface (`src/main/host/*`), with Electron as the first implementation. No behaviour change; tests prove it.
2. **Swift app skeleton:** NSPanel + WKWebView loading `dist/renderer`, a `window.glide` JS shim, spawning bundled Node with `src/main` built for plain Node (`host` = Swift over stdio). Behind a build flag; Electron remains the default.
3. **Feature parity of host requests:** windows, tray/menu bar, notifications, dialogs, clipboard, keychain, login item, updater (zip swap logic reused), file icons via NSWorkspace.
4. **Merge the helper:** move today's helper code into the app target; delete the child process and its NDJSON hop for native calls.
5. **Tests:** port the CDP harness to WKWebView (Safari Web Inspector protocol is not CDP) or drive the shim directly from Node in headless mode; keep visual baselines.
6. **Switch default, remove Electron.**

## Risks

- **Rendering:** WKWebView differs from Chromium (CSS, `structuredClone`, `ClipboardItem`). Mitigation: run the visual suite early in phase 2.
- **Tests:** the CDP-based harness doesn't speak to WKWebView. Phase 5 is real work.
- **Node runtime:** bundling and signing Node (~40 MB) is needed for extensions and the agent.
- **Migration:** the safeStorage → Keychain migration needs one decrypt with Electron's key during the first native launch.

## Estimates

- **Size:** ~60–80 MB DMG (app + Node + renderer assets).
- **Memory:** ~150–250 MB RSS. One WebContent process per window replaces Chromium's renderer/GPU/utility processes.
