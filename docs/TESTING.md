# Testing Glide

Glide has three layers of tests:

| Layer | Command | What it covers |
| --- | --- | --- |
| Unit | `pnpm test` (vitest, `src/**/*.test.ts`) and `pnpm test:harness` (node:test, `tests/unit`) | Pure logic: search engine, features' models, the harness itself (PNG codec, fixtures, ports) |
| Headless end-to-end | `node scripts/e2e.mjs`, `pnpm test:e2e:smoke` | The real Electron app driven over the Chrome DevTools Protocol |
| Quality | `pnpm test:perf`, `pnpm test:a11y`, `pnpm test:visual` | Search latency, startup and memory; keyboard and accessibility audit; pixel regressions |

`pnpm test:quality` runs the harness unit tests, the smoke suite, perf and a11y in that order.
Every suite except the unit tests needs a built app: run `pnpm build` (or `pnpm build:main && pnpm build:renderer`) first.

## Headless mode

All runtime tests launch Glide with `GLIDE_HEADLESS=1` (see `src/main/headless.ts`). In this mode
Glide never puts anything on screen or touches the session:

- Windows render (CDP and `Page.captureScreenshot` work) but are never shown or focused; focus is emulated so typing works.
- Global shortcuts, notifications, dialogs, `shell.openExternal`/`openPath`, tray titles and the clipboard are faked.
  Each suppressed side effect is printed as a `[headless] <kind> <detail>` line, so tests assert on those
  lines (for example `[headless] shell.openExternal https://github.com/search?q=...`).
- The native helper only answers read-only methods.

The harness adds more isolation on top:

- **Data**: a fresh `GLIDE_USER_DATA` directory per launch, seeded with deterministic fixtures
  (`tests/harness/fixtures.mjs`): workflows, quicklinks, snippets, clipboard history, color history,
  paused timers and a stopwatch, fake `.app` bundles (the only `appDirectories`), a small file tree (the only file-index scope),
  plus settings that turn off update checks, currency downloads and Spotlight.
- **Home**: `HOME` points at an empty fake home inside the data dir, so features that read `~`
  (browser bookmarks, scripts, notes) never see your data. Pass `{ realHome: true }` to opt out.
- **Helper**: disabled by default (`GLIDE_HELPER_PATH` points at nothing), which is also what CI looks like. Pass `{ helper: true }` to use it.
- **Build snapshot**: `snapshotApp()` copies `dist/` and `package.json` to a temp directory, so a `pnpm build`
  running in another terminal cannot swap bundles under a running suite. `GLIDE_TEST_SNAPSHOT=0` disables it.
- **Keychain**: Chromium's `--use-mock-keychain` keeps `safeStorage` (AI/agent API-key stores) out of your login keychain. `{ realKeychain: true }` opts out.
- **No network**: API keys are blanked and `GLIDE_UPDATE_BASE_URL` points at a closed local port.

Never run Glide for tests without `GLIDE_HEADLESS=1`; the harness sets it unconditionally.

## The harness (`tests/harness`)

```js
import { launchGlide, withGlide, snapshotApp, sleep } from "../tests/harness/index.mjs";

await withGlide({ appDir: snapshotApp(), fixture: { theme: "light", catalogueSize: 500 } }, async (app) => {
  const page = await app.launcher();             // CDP Page for the launcher (waits for the search field)
  await page.type("safari", { selector: "input" });
  await page.press("ArrowDown");                  // "Enter", "j", "G", "cmd+k", "shift+Tab", ...
  await page.waitFor(() => document.querySelectorAll('[role="option"]').length > 0);
  const png = await page.screenshot();            // Buffer
  const settings = await app.settings("appearance");
  app.headless("shell.openExternal");             // parsed [headless] lines
  await app.waitForLog(/\[headless\] notification/);
});                                               // always killed + data dir removed
```

| Module | Purpose |
| --- | --- |
| `app.mjs` | `launchGlide(opts)` / `withGlide(opts, fn)`: spawns the real Electron binary (never `node_modules/.bin/electron`) headless with a CDP port, collects stdout/stderr, `page()`, `launcher()`, `settings(route)`, `headless(kind)`, `waitForLog(re)`, `errors()`, `memory()` (RSS of the process tree), `mainEval(expr)` (with `inspectMain: true`). |
| `page.mjs` | `Page`: `eval(fnOrExpr, ...args)`, `waitFor`, `waitForSelector`, `waitForIdle`, `press`, `type`, `clear`, `setViewport` (1x), `stabilise()` (no animations/caret/pointer), `rects(selectors)`, `screenshot()`, `console` / `errorsSince()`. |
| `fixtures.mjs` | `seedDataDir(dir, opts)`, `syntheticQuicklinks(n)`, `perfQueries(n)`, seeded `rng`. |
| `ports.mjs` | `allocatePort()` from the reserved window 9470-9479 (`GLIDE_TEST_PORT_BASE` / `GLIDE_TEST_PORT_COUNT` to move it). |
| `png.mjs` | Dependency-free PNG decode/encode (node:zlib), `diffImages`, `downscale`, `maskRects`. |
| `a11y-probe.mjs` | In-page audit functions used by the a11y suite. |
| `report.mjs` | `createReporter(name)`: `check`, `step`, `warn`, `summary`. |

Cleanup is guaranteed: every launched process is tracked and killed (SIGTERM, then SIGKILL, including
Electron's helper processes, which are verified to be descendants of the PID we spawned) on success,
failure, uncaught exceptions, SIGINT/SIGTERM and a watchdog (`GLIDE_TEST_WATCHDOG_MS`, default 5 min).
Data dirs go under `GLIDE_TEST_TMP` (default `$TMPDIR/glide-tests`) and are removed unless `keepData: true`.
Set `GLIDE_TEST_DEBUG=1` to stream the app's output.

### Writing suites that survive UI churn

- Select by role and ARIA (`[role="listbox"] [role="option"]`, `[role="dialog"][aria-label="Actions"]`), not layout classes.
- Find views and settings pages through the registry (`window.__glideLauncher.views()`, the settings sidebar) instead of hard-coding lists.
- Assert "contains" rather than exact row lists; new features add rows and sections.
- Assert side effects on `[headless]` log lines, not on the outside world.

## Visual regression

```sh
pnpm test:visual                    # compare against tests/visual/baselines
pnpm test:visual:update             # re-record every baseline
node scripts/visual-snapshots.mjs --only=timers,themes --themes=nord --update
```

Captured screens: root (empty, with a query), the ⌘K action panel, conversions, clipboard history, timers,
color history, transforms, the theme switcher, and Settings → General / Appearance / Workflows, each in
Glide Dark, Glide Light and Nord. Launcher screens are 760×560 and settings 1040×720, both at 1x
(device-scale override, so retina and non-retina hosts produce the same image; captures are also downscaled
if a host ignores it). Translucent panels are composited over a flat grey backdrop.

Determinism: fixture timestamps are relative to launch, so ages ("2d") are stable; timers are paused;
animations, transitions and the caret are disabled; elements matching `.toast`, `time`, `[data-test-dynamic]`
or a screen's own `masks` are painted magenta before comparing. If you add a dynamic region to a screen, give
it `data-test-dynamic` or add a mask selector in `scripts/visual-snapshots.mjs`.

A screen fails when more than `--max-ratio` (default 0.3 %) of its pixels differ by more than `--threshold`
(default 24 of 255 in any channel). Failures write `tests/visual/out/<theme>/<screen>.actual.png` and a
`.diff.png` (changed pixels in red over a faded baseline); `tests/visual/out/report.json` lists everything.
A view that no longer exists is reported as `skipped`, not failed.

**Updating baselines**: when a change is intended (new sidebar entry, restyled row), run
`pnpm test:visual:update`, look at the changed PNGs, and commit them with the change. Baselines are recorded
on macOS; font rendering on CI runners can differ, which is why the CI `visual` job is allowed to fail and
uploads its diffs as an artifact instead.

## Keyboard & accessibility audit

```sh
pnpm test:a11y                     # fails on violations not in tests/a11y/baseline.json
pnpm test:a11y -- --verbose        # list every violation
pnpm test:a11y -- --update         # accept the current set as the baseline
```

The audit walks the launcher root, the ⌘K panel, **every registered launcher view** and **every settings
page** (discovered from the sidebar), and checks:

| Rule | Check |
| --- | --- |
| `keyboard` | Interactive elements (native controls, ARIA widget roles, anything with a React click handler) are focusable, part of a keyboard-driven list (the launcher's search field drives every list), or advertise a shortcut (`⌘P`, `aria-keyshortcuts`). |
| `name` | Interactive elements have an accessible name (aria-label/labelledby, label, text, title, placeholder). |
| `focus-visible` | Every focusable element shows a visible change on keyboard focus (outline, box-shadow, colour, border); text fields may rely on the caret. |
| `contrast` | Text meets WCAG AA (4.5:1, 3:1 for large text), computed from styles over the theme background, including opacity. |
| `arrow-nav` | In screens with a list, ArrowDown moves the selection. |
| `tab-order` | In settings pages, real Tab presses reach every focusable element and never get stuck. |
| `crash` | No error-boundary crash or uncaught exception while the screen is open. |

Violation keys are stable across data (row text such as process names or bookmarks is never part of a key),
so the baseline does not churn. The run prints a table per screen and writes `tests/a11y/out/report.json`.
When you fix violations, run with `--update` so they cannot come back.

## Performance

```sh
pnpm test:perf
node scripts/perf-search.mjs --items=20000 --queries=500 --startup-runs=5 --strict
```

- **Engine-only**: bundles `src/engine` with esbuild and ranks a seeded 10,000-item catalogue (the same synthetic
  quicklinks the app gets) for 200 deterministic queries after a warm-up.
- **IPC**: launches Glide with those 10,000 quicklinks in its data, then times `window.glide.search(q)` from the
  renderer, which includes IPC, the engine and every feature's dynamic items.
- **Startup**: cold launches with fresh data dirs; spawn → renderer start, DOMContentLoaded and first result rows
  (median of `--startup-runs`), plus one launch with the 10k catalogue.
- **Memory**: RSS of every Glide process after the run and a few views, plus the launcher JS heap and main-process
  heap (via the main inspector).

Results go to `tests/perf/out/perf-search.json`. Thresholds live in `tests/perf/thresholds.json`: search p95
above 30 ms (engine) or 60 ms (IPC) fails the run; startup and memory only warn unless `--strict`.
`GLIDE_PERF_THRESHOLD_SCALE=2` (or `--scale=2`) loosens every threshold on slow shared hardware.

## CI

`.github/workflows/ci.yml` runs, on `macos-latest`:

- `test`: typecheck + vitest.
- `quality`: builds main + renderer (the helper is not needed), then unit tests (vitest + harness), both headless
  e2e suites, perf and the a11y audit; perf and a11y reports are uploaded as the `quality-reports` artifact.
- `visual`: the pixel comparison, `continue-on-error: true` because CI fonts and antialiasing differ from the Macs
  the baselines were recorded on; diffs are uploaded as the `visual-diffs` artifact.
