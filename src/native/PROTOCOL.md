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
