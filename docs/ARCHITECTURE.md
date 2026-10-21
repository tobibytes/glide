# Architecture

```
┌──────────────── Electron main (Node) ─────────────────┐      ┌──────── glide-helper (Swift) ────────┐
│ window · tray · hotkeys · store (data.json)            │ NDJSON│ AX selection · windows · menus      │
│ catalogue ── engine (pure TS ranking)                  │◀────▶│ keyboard tap (snippets, Hyper key)  │
│ executor · workflow runtime                            │ stdio │ layouts · OCR (Vision) · color      │
│ feature host ── features/<id> (items, actions, methods)│      │ calendar (EventKit) · Spotlight key │
│ extensions ── utilityProcess per command               │      └─────────────────────────────────────┘
└───────────────▲───────────────────────────────────────┘
                │ IPC (window.glide bridge, src/preload)
┌───────────────┴──── Renderer (React 19) ───────────────┐
│ launcher (NavList + vim) · views "<feature>.<view>"    │
│ settings window · feature windows "#/<feature>/<name>" │
└────────────────────────────────────────────────────────┘
```

- **`src/shared/`**: types and the IPC contract (`ipc.ts`). The renderer only talks to main through `window.glide`.
- **`src/engine/`**: the search engine with no Electron dependency: fuzzy scorer, sensitivity gate, tiered comparator, frecency. Fully unit-tested.
- **`src/main/`**: app lifecycle, catalogue sources (apps, system commands, files, calculator), execution, workflow runtime, and the **feature host** (`features/host.ts`). It merges each feature's `items()`, `dynamicItems(query)` (250 ms budget), actions and renderer-callable `methods`.
- **`src/main/features/<id>/`**: one folder per feature, registered in `features/registry.ts`. A feature never imports another feature's internals except through exported functions.
- **`src/native/GlideHelper/`**: a Swift command-line helper, built by `scripts/build-helper.mjs` and shipped in `Contents/Resources/bin`. It speaks newline-delimited JSON over stdio (see `src/native/PROTOCOL.md`), and macOS attributes its permissions to Glide.
- **`src/extension-api/`**: the extension runtime. Each command runs in an Electron utility process. Raycast-style extensions run on a small React-compatible runtime whose tree is serialized to JSON and rendered natively by the launcher.
- **`src/renderer/`**: the React UI. Every list is a `NavList`, which provides vim keys, sections, a detail pane and the ⌘K action panel. Themes are CSS variables generated in `features/appearance/themes.ts`.

## Data

`~/Library/Application Support/Glide/`: `data.json` (settings, workflows, quicklinks, snippets, aliases, hotkeys), `usage.json` (frecency), and `features/<id>/` (per-feature data). The AI key is stored with Electron `safeStorage`, which uses the macOS keychain.

## Testing

- `pnpm test`: vitest unit tests for the engine, features, parsers, runtime and merge logic.
- `pnpm test:e2e`: launches the real app with an isolated data dir and drives it over the DevTools protocol.
- `scripts/ext-raycast-e2e.mjs`: end-to-end checks for Raycast-style extensions.
