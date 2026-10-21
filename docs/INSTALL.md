# Installing, updating and releasing Glide

## Install on this Mac

```sh
pnpm install:app    # builds, packages, signs, copies to /Applications/Glide.app, deletes release/
```

Glide is a menu-bar app (no Dock icon). Turn on **Launch at login** in Settings → Updates & App (or run "Toggle Launch at Login" from the launcher); it only takes effect in the packaged app. The packaged bundle contains the Swift helper at `Contents/Resources/bin/glide-helper` when `build/bin/glide-helper` exists (`pnpm build:helper`); without it packaging warns and the native features report that the helper is unavailable.

Permissions: macOS asks the first time Glide uses AppleScript/Automation, Calendars, or your Desktop/Documents/Downloads folders (purpose strings are in the Info.plist). Accessibility and Input Monitoring have no Info.plist strings; grant them in System Settings → Privacy & Security when a feature asks.

## Versioning

`pnpm version patch` (or `minor` / `major`) bumps `package.json`; the packaged app takes `CFBundleShortVersionString` from it and Settings → Updates & App shows it.

## Architectures

| Command | Output | Notes |
| --- | --- | --- |
| `pnpm package` / `pnpm release` | `release/Glide-darwin-<host>/Glide.app` (+ zip) | host arch, fast, offline once Electron is cached |
| `node scripts/package.mjs --arch x64 --zip` | `release/Glide-darwin-x64.zip` | Intel only |
| `pnpm release:universal` | `release/Glide-darwin-universal.zip` | arm64 + x86_64 in one bundle (what CI publishes) |

`--arch universal` packages an x64 and an arm64 slice and stitches them with `@electron/universal` (a dependency of `@electron/packager`); the first run downloads the x64 Electron zip into the Electron cache. The Swift helper follows the same flag: `pnpm build:helper` builds the host arch for dev, `node scripts/build-helper.mjs --arch universal` compiles both slices and joins them with `lipo` (`--out <path>` writes somewhere other than `build/bin/glide-helper`). `package.mjs` reuses `build/bin/glide-helper` when it already has every slice the target needs, and otherwise compiles a matching helper into its staging folder. It refuses to finish when `Contents/MacOS/Glide` or the helper lacks a slice; check with `lipo -info`.

esbuild (used to build imported Raycast extensions that ship only sources) is per-arch. pnpm installs only the host's `@esbuild/darwin-*` package, so a universal build made on Apple Silicon carries only the arm64 esbuild and, on Intel Macs, Glide can then import only Raycast extensions that ship a prebuilt `dist/`. A universal build made where `@esbuild/darwin-x64` is installed carries both, and esbuild picks the right one at runtime.

## Releases and auto-update

There is no update server: Glide reads GitHub Releases. The default feed is `tobibytes/glide`; change it or clear it in Settings → Updates & App (an empty feed turns updates off and Glide makes no update requests).

### Automated (GitHub Actions)

`.github/workflows/release.yml`:

- **Tag push `vX.Y.Z`** (must equal `package.json`'s version): installs, typechecks, tests, builds, runs `package.mjs --arch universal --zip`, verifies both slices with `lipo -verify_arch`, `codesign --verify --deep --strict` and the checksum, then creates a GitHub Release with `Glide-darwin-universal.zip` + `.sha256` and auto-generated notes.
- **Run workflow** (workflow_dispatch) is a dry run: the same build, artifacts uploaded to the run for 14 days, no release.
- CI builds are ad-hoc signed. When the repository has the secrets `CSC_LINK` (base64 Developer ID Application `.p12`), `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_TEAM_ID` and `APPLE_APP_PASSWORD`, tag builds (and dry runs with "Notarize" ticked) import the certificate into a temporary keychain and run `scripts/notarize.mjs --zip --arch universal`.

To release: `pnpm version patch && git push --follow-tags`.

### Manual

1. `pnpm release:universal` (or `pnpm release` for the host arch) builds `release/Glide-darwin-<arch>.zip` (made with `ditto -c -k --keepParent`) and `release/Glide-darwin-<arch>.zip.sha256`.
2. Create a GitHub release tagged `vX.Y.Z` (matching `package.json`) and attach both files with exactly those names.

### What the updater does

Glide checks `https://api.github.com/repos/<owner>/<repo>/releases/latest` 15 s after start and every 6 hours (unless "Check automatically" is off; background checks run only in the packaged app and never in headless test runs), ignores drafts and prereleases, and when the tag is newer it adds "Update Glide to vX.Y.Z" to the launcher and posts a notification. It picks the asset for the running architecture (`process.arch`): `Glide-darwin-arm64.zip` or `Glide-darwin-x64.zip` first, then `Glide-darwin-universal.zip`, each only together with its `.sha256`; it never offers another arch's build. Installing downloads the zip, checks its SHA-256 against the `.sha256` asset, unpacks it with `ditto -x -k`, requires `codesign --verify --deep --strict` to pass and the bundle identifier and version to match, moves the running Glide.app to the Trash, moves the new one into its place and relaunches. Any failed check leaves the installed app untouched.

An ad-hoc signed update still passes these checks, but Gatekeeper will quarantine-prompt a downloaded ad-hoc build on other Macs; notarize releases you hand to other people.

## Notarization (needs a paid Apple Developer account)

```sh
APPLE_ID=you@example.com APPLE_TEAM_ID=ABCDE12345 APPLE_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx \
  pnpm release:universal && node scripts/notarize.mjs --zip --arch universal
```

`scripts/notarize.mjs` (`--arch` defaults to the host arch, like `package.mjs`) signs every nested binary inside-out with your "Developer ID Application" identity, hardened runtime and `build/entitlements.mac.plist` (JIT and unsigned executable memory for V8, Apple Events, Calendars; the helper gets `build/entitlements.helper.plist`), submits with `xcrun notarytool submit --wait`, staples, checks with `spctl`, and rebuilds the release zip and checksum. Set `APPLE_SIGN_IDENTITY` if you have several identities. Without the credentials and identity it lists what is missing and exits without changing anything.

## Data

Settings → Updates & App can show the data folder, export or import `data.json` through a save/open dialog, and reset Glide to defaults. Import and reset first write a backup to `~/Library/Application Support/Glide/backups/`.

## Stable local signing (recommended)

Ad-hoc signatures change on every build, and macOS ties privacy grants (Accessibility, Input Monitoring, keychain access) to the signature, so each rebuild would ask again. Run once:

```sh
node scripts/setup-signing.mjs
```

It creates a self-signed "Glide Local Signing" identity in its own keychain (`~/Library/Keychains/glide-signing.keychain-db`) and trusts it for code signing only; macOS asks you to approve that. `pnpm install:app` then signs with it automatically, and grants survive rebuilds.

## Sharing a DMG

```sh
pnpm dmg   # → release/Glide-<version>-universal.dmg (+ .sha256)
```

The disk image contains Glide.app, an Applications shortcut and a "Read Me First.txt" explaining the one-time Gatekeeper step ("Open Anyway" in Privacy & Security, or `xattr -dr com.apple.quarantine /Applications/Glide.app`). Build DMGs on the same Mac with the same "Glide Local Signing" identity: macOS ties recipients' Accessibility and Input Monitoring grants to that certificate, so later versions keep them.
