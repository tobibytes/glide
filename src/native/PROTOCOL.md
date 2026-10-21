# Glide helper protocol

`glide-helper` is a Swift command-line binary started by the main process (src/main/native/helper.ts).
It speaks newline-delimited JSON over stdin/stdout. stderr is for logs only.

- Request (main → helper): `{"id": 1, "method": "windows.apply", "params": {"action": "left-half"}}`
- Response (helper → main): `{"id": 1, "result": {...}}` or `{"id": 1, "error": "message"}`
- Event (helper → main, no id): `{"event": "snippet.expanded", "data": {"keyword": ";sig"}}`

Methods, params and results are typed in `HelperMethods` and `HelperEvents` in src/main/native/helper.ts; that file is the source of truth.

Location: development `build/bin/glide-helper`; packaged `Contents/Resources/bin/glide-helper`.
The helper inherits the app's Accessibility / Input Monitoring / Calendar grants because it is spawned by Glide and lives in its bundle.

## Implementation notes (src/native/GlideHelper/*.swift, built by scripts/build-helper.mjs)

- "Target app" for app.frontmost, selection.text, windows.apply and menus.*: the frontmost app unless it is Glide
  (parent pid, `dev.glide.launcher`, or `com.github.Electron` in dev), else the last app seen via
  `NSWorkspace.didActivateApplicationNotification`, else the owner of the front-most on-screen window.
- selection.text: AX `AXSelectedText` of the focused element; on an empty read it sets `AXManualAccessibility`
  on the app once per pid (Electron/Chromium build their AX tree lazily) and reads again after 150 ms.
- stdin EOF, SIGTERM/SIGINT/SIGHUP: restore the Caps Lock mapping, remove the event tap, exit 0 (in-flight requests get up to 5 s).
- Hyper key: the pre-change `UserKeyMapping` is saved to `~/Library/Caches/dev.glide.launcher/hyper-key-previous-mapping.json`
  and restored on the next launch if the helper died without cleaning up. The mapping is only applied when the tap exists.
- `permissions.changed` is polled every 2 s; a failed tap is retried when permissions change.
- `GLIDE_HELPER_DRY_RUN=1`: hidutil `--set` calls are logged to stderr instead of executed, and the test-only method
  `debug.hyperDryRun` (exists only in dry-run mode) runs enable → disable and returns the commands.
- The TS client replays the last `keys.configure` after a helper restart.
- color.pick: shows `NSColorSampler` (the system magnifier loupe; no Screen Recording permission needed). The helper
  switches its activation policy from `.prohibited` to `.accessory` while the loupe is up and back afterwards.
  Returns `{hex:"#RRGGBB", r, g, b, a}` (sRGB) or `{hex:null, reason:"cancelled"|"timeout"}`; params `{timeoutMs?}` (default 120 s).
  The caller hides the launcher first. It is in the TS client's SLOW_METHODS so the 10 s call timeout does not apply.

### Window layouts (layouts.*, apps.quit)

- `layouts.displays`: active displays in AX coordinates (main first) with `id` (CGDirectDisplayID), `uuid`
  (CGDisplayCreateUUIDFromDisplayID — stable across reboots), `name` (NSScreen.localizedName), `frame`, `visible`.
- `layouts.apps`: running `.regular` apps except Glide, `Apps.describe` + `hidden`.
- `layouts.capture {includeHidden?}`: needs Accessibility. For every regular app (hidden apps skipped by default) reads
  `AXWindows` and keeps standard, non-minimized windows ≥ 40×40. Each window gets a `ref` (an int keyed to the cached
  AXUIElement) valid until the next capture, plus `display` (index of the display with the largest overlap) and `order`
  (index among that app's kept windows, front to back). Matching saved layouts to live windows happens in TypeScript.
- `layouts.move {moves:[{ref, frame, raise?}]}`: un-minimizes, sets size → position → size, optionally raises, and
  returns the frame the app accepted. Full-screen windows are reported as errors and left alone.
- `apps.quit {bundleIds}`: `NSRunningApplication.terminate()` (polite quit; apps can still prompt to save). Glide only
  calls it after the user confirmed in the Workspace view.

### OCR (ocr.*)

- `ocr.recognize {path, languages?, fast?, languageCorrection?}`: `VNRecognizeTextRequest` (accurate unless `fast`,
  language correction on by default, `automaticallyDetectsLanguage` when `languages` is empty). Returns observations in
  Vision's order with `confidence` and a normalised top-left-origin `box`; line/paragraph assembly is done in TypeScript.
- `ocr.barcodes {path}`: `VNDetectBarcodesRequest`; de-duplicated `{payload, symbology, box}`.
- Both read any ImageIO format; the caller owns (and deletes) the file. Both are in SLOW_METHODS.

### Finder selection (finder.*)

- `finder.selection` → `{paths, folder, source:"ax"|"none", error?}`. Needs **Accessibility** only (never prompts; without
  the grant it returns `paths: []` and an `error`). Reads Finder's `AXFocusedUIElement` (falls back to the focused/main
  window) and its `AXSelectedRows` / `AXSelectedChildren` / `AXSelectedCells`; if the focus is elsewhere it walks the
  window (≤ 4000 elements) and keeps the deepest container with a selection (column view). Each item's path is its
  `AXURL` when present, else the window's `AXDocument` folder + the item's displayed name (`AXFilename`, the first
  text field's value, or the icon's title). Only existing paths are returned. `folder` is the window's `AXDocument`
  folder, or ~/Desktop when Finder has no window (desktop selection). Used by S5's getSelectedFinderItems — keep the shape.
- `finder.selectionViaAutomation` → same shape with `source:"automation"`: `NSAppleScript` asks Finder for
  `selection as alias list` and `insertion location`. The first call shows the **Automation (Apple Events → Finder)**
  prompt, so Glide only calls it when the user enabled "Ask Finder directly" in Settings. In SLOW_METHODS.

### Reminders (reminders.*)

- Needs **Reminders full access** (`EKEventStore.requestFullAccessToReminders`), requested only by
  `permissions.request {kind:"reminders"}` from an explicit user action. `permissions.status` now includes
  `reminders` (same values as `calendar`) and `location`; both fields are optional in TS for older helpers.
- `reminders.lists` → `[{id, title, color, isDefault, writable}]`.
- `reminders.list {listId?, includeCompleted?}` → reminders (`fetchReminders`, 15 s timeout; in SLOW_METHODS).
  Each: `{id (calendarItemIdentifier), title, completed, priority, listId, listTitle, color, due?, dueAllDay?,
  completionDate?, notes?, url?}`; `due` is ISO 8601 (local midnight when `dueAllDay`).
- `reminders.create {title, due?, allDay?, listId?, notes?}`: list defaults to `defaultCalendarForNewReminders`;
  `allDay` stores only y/m/d; timed reminders get an `EKAlarm` at the due time (like Reminders.app).
- `reminders.complete {id, completed?=true}`.
- All throw "Reminders access has not been granted" until authorized. The store is recreated after a grant.

### Wi-Fi (wifi.info)

- `wifi.info` → `{ssid, bssid, interface, poweredOn, connected, locationStatus, needsLocation}` via CoreWLAN. Read-only and
  never prompts (it is in HEADLESS_HELPER_METHODS). On macOS 14+ `ssid`/`bssid` are null unless Glide has
  **Location Services** access; `needsLocation` is true when associated but the name is hidden.
- `permissions.request {kind:"location"}` shows the Location prompt (`CLLocationManager.requestWhenInUseAuthorization`
  plus a briefly started update, which some macOS versions need before prompting); waits ≤ 120 s for an answer.
  Glide calls it only from Settings → Finder & Wi‑Fi → "Allow Location Access…". TS wrapper: src/main/native/wifi.ts.
- Usage strings (NSRemindersFullAccessUsageDescription, NSLocation*UsageDescription, NSAppleEventsUsageDescription) are in
  the helper's embedded Info.plist.
