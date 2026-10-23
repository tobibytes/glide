# Testing native Glide

Run everything with `scripts/test.sh` (it runs `swift build` and then `swift test`). The end-to-end suites
(`Tests/GlideAppTests`, and the feature suites that use the harness) spawn the real `Glide` binary headless and
drive it over its test channel.

> `swift test` does not relink the `Glide` executable. The Swift driver refuses a binary that is older than its
> object files, so run `swift build` first. In a parallel session, use your own scratch dir for both:
> `swift build --scratch-path D && swift test --scratch-path D`.

## Headless mode

Headless mode is set by `GLIDE_HEADLESS=1`, `--headless`, or the test server, which always implies it.

| Area | Headless behaviour |
| --- | --- |
| Screen | The launcher panel exists and renders offscreen for snapshots, but every order-front and make-key call is a no-op. No menu bar item, Dock icon, Settings window or alert is created. The activation policy is `.prohibited`. |
| Services | `SystemServicesFactory.headless(log:)` swaps every OS service for a fake (`Sources/GlideSystem/Headless/Fakes.swift`). Fakes never post events, create taps, register real hotkeys, touch the real pasteboard, read another app's AX tree or show permission prompts. |
| Side effects | Every side effect is recorded in `SideEffectLog` and echoed to stdout as `[headless] <kind> <json detail>`, e.g. `[headless] launch-app {…}`, `[headless] pasteboard-set {…}` or `[headless] hotkeys-set [...]`. |
| Theme | The theme is opaque, so snapshots are deterministic and do not depend on what is behind the panel. |

| Variable | Meaning |
| --- | --- |
| `GLIDE_USER_DATA` | Data directory (**always** a fresh temp dir for tests; never `~/Library/Application Support/Glide`). |
| `GLIDE_HEADLESS=1` | Headless mode. |
| `GLIDE_TEST_SERVER=1` / `--test-server` | Enable the stdin/stdout test channel (implies headless). |
| `GLIDE_TEST_PARENT_PID` | Watchdog: exit (code 3) when this pid disappears. The app also exits when reparented to launchd, or when stdin closes. |
| `GLIDE_HEADLESS_SELECTION` | Text the fake selection service returns. |
| `GLIDE_HEADLESS_CONFIRM=0` | Fake confirmations answer "Cancel" (the default answers OK). |
| `GLIDE_HELPER_DRY_RUN=1` | Key remapping logs instead of calling `hidutil`. |
| `GLIDE_VERBOSE=1` | `[glide] …` diagnostics on stderr. |
| `GLIDE_BINARY` | The binary the drivers spawn. The default is the `Glide` next to the loaded test bundle, so a `--scratch-path` build drives its own binary; the last resort is `.build/debug/Glide`. |
| `GLIDE_E2E_TMP` | The parent directory for the drivers' fresh data dirs. |
| `GLIDE_DYNAMIC_BUDGET_SCALE` | Test server only: multiplies the per-feature dynamic-items budget (default 3, so rankings stay deterministic on a loaded CPU). Set it to 1 to test the production budget. |

## Test-server protocol

The channel is newline-delimited JSON on stdin and stdout.

- **Startup:** the app prints `{"event":"ready","ok":true,"startupMs":N}` once.
- **Requests and responses:** each request is one JSON object with `"cmd"` and an optional `"id"`. Commands run strictly in order. Each response is one line, `{"ok":true,…,"id":<same>}`. Failures carry `"ok":false,"error":"…"`.
- **Other output:** lines starting with `[headless]` are side effects, not responses.

| cmd | Fields | Response |
| --- | --- | --- |
| `ping` | | `pong` |
| `show` | | `visible`, `showMs` (show through first render, including search and layout), `panelShowMs` (window work only) |
| `hide` | | `visible` |
| `type` | `text` | state; each character goes through the key path first, like a real key press |
| `key` | `key`: `down` `up` `enter` `esc` `tab` `backspace` `cmdK` `cmdEnter` `ctrlJ` `ctrlK` `ctrlN` `ctrlP` `ctrlD` `ctrlU` `shiftEnter` `cmdE` `cmd+1` `shift+tab` `cmd+shift+c`, or one character (`j`, `G`, `/`) | state plus `consumed` |
| `setQuery` | `text` | state (sets the field directly) |
| `state` | | state (after in-flight dynamic results settle) |
| `snapshot` | `path` | launcher PNG at 2× (`path`, `width`, `height`, `ms`) |
| `snapshot` | `target: "settings"`, `page`, `path` | Settings shell rendered offscreen (no window). The sidebar's vibrancy material renders blank offscreen. |
| `metrics` | | `footprintMB`, `residentMB`, `items`, `startupMs`, `uptimeS` |
| `invoke` | `feature`, `method`, `args` | `result` (see below) |
| `quit` | | flushes the store, then exits 0 |

The state object contains:

- `query`, `rows[]` (`id`, `title`, `kind`, `section`, `selected`, `subtitle?`, `argument?`)
- `view` and `stackDepth`
- `mode` (`insert`/`normal`) and `vimEnabled`
- `visible`, `placeholder`, `primaryAction`, `contextTitle` (the footer's readable title)
- `toast` and `toastStyle`
- `theme`
- `actionPanel` (`open`, `title`, `filter`, `selected`, `actions[]`)
- `argumentFor`

The built-in `invoke` targets are:

| feature / method | Use |
| --- | --- |
| `headless/effects` | Recorded side effects so far. |
| `headless/clearEffects` | Reset the side-effect log. |
| `headless/pasteboard` | The fake pasteboard's string. |
| `headless/hotkeys` | Currently registered hotkey bindings. |
| `headless/pressHotkey {id}` | Simulate a global hotkey press (`launcher` toggles the panel). |
| `launcher/push {view,payload}` | Push a view. |
| `launcher/pop` | Pop a view. |
| `launcher/expireIdle` | Simulate 90 s idle (the next `show` pops to root). |
| `store/data` | The current `data.json` model. |
| `store/usage` | The current `usage.json` model. |
| `store/flush` | Write the store to disk. |
| `store/setSettings {vimMode, keepOpenAfterRun, hideOnBlur, theme, hotkey, sectionLimit, calculator, appearance}` | Change settings. |
| `<featureId>/<method>` | Forwarded to that feature's `invoke(method:args:)`. |

## Drivers

### Swift: `Tests/Harness/GlideDriver.swift` (target `GlideTestHarness`)

```swift
import GlideTestHarness
@Test func safariFirst() throws {
    let d = try GlideDriver(seed: ["data.json": fixture], environment: ["GLIDE_HEADLESS_SELECTION": "hello"])
    defer { d.stop() }                       // quit → SIGTERM → SIGKILL; temp data dir removed
    _ = try d.show()
    try d.type("saf")
    #expect(try d.titles().first == "Safari")
    try d.key("cmdK")
    _ = try d.snapshot(dir + "/actions.png")
    #expect(d.sideEffects.contains { $0.kind == "launch-app" } == false)
}
```

The driver spawns a fresh temp `GLIDE_USER_DATA`, sets `GLIDE_TEST_PARENT_PID` and correlates responses by
`id`. It provides `send`, `show`, `hide`, `type`, `key`, `state`, `snapshot`, `metrics`, `invoke`, `titles`,
`selectedTitle`, `sideEffects` and `outputLines`. A feature test target depends on `GlideTestHarness` (and on
`Glide` if it should build the binary first).

### Node: `Tests/Harness/glide-driver.mjs` (no dependencies)

```sh
node Tests/Harness/glide-driver.mjs [--binary build/Glide.app/Contents/MacOS/Glide] [--seed data.json] [--keep] script.json
```

`script.json` is an array of commands. Each command can carry `"expect": {"<dotted.path>": value}`, which is
compared deep-equal, and `"print": true` to echo the response. The driver prints `✓`/`✗` for each step and exits 1
on any failure. Set `TMPDIR` to control where the temp data dir is created.

```json
[
  {"cmd":"invoke","feature":"store","method":"setSettings","args":{"vimMode":false}},
  {"cmd":"show","expect":{"visible":true},"print":true},
  {"cmd":"type","text":"saf","expect":{"rows.0.title":"Safari"}},
  {"cmd":"key","key":"cmdK","expect":{"actionPanel.open":true}},
  {"cmd":"snapshot","path":"/tmp/x/actions.png"},
  {"cmd":"key","key":"esc","expect":{"actionPanel.open":false,"query":"saf"}},
  {"cmd":"key","key":"esc","expect":{"query":""}},
  {"cmd":"key","key":"esc","expect":{"visible":false}},
  {"cmd":"metrics","print":true}
]
```

## Rules for tests

- Never run the app non-headless from tests or scripts. Never use `open`, `osascript`, `screencapture`, or anything that activates apps.
- Always use a fresh data directory. Kill what you start. Both drivers do this, and the app's watchdog exits if the driver dies.
- The offline self-tests (`Glide --selftest-keys <fixture>`, `--selftest-hotkeys <fixture>`) exercise key and hotkey parsing without taps or events. `GlideSystemTests` uses them.
