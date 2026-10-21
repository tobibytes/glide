# Installing, updating and releasing Glide

## Install on this Mac

```sh
pnpm install:app    # builds, packages, signs, copies to /Applications/Glide.app, deletes release/
```

Glide is a menu-bar app (no Dock icon). Turn on **Launch at login** in Settings → Updates & App (or run "Toggle Launch at Login" from the launcher); it only takes effect in the packaged app. The packaged bundle contains the Swift helper at `Contents/Resources/bin/glide-helper` when `build/bin/glide-helper` exists (`pnpm build:helper`); without it packaging warns and the native features report that the helper is unavailable.

Permissions: macOS asks the first time Glide uses AppleScript/Automation, Calendars, or your Desktop/Documents/Downloads folders (purpose strings are in the Info.plist). Accessibility and Input Monitoring have no Info.plist strings; grant them in System Settings → Privacy & Security when a feature asks.

## Versioning

`pnpm version patch` (or `minor` / `major`) bumps `package.json`; the packaged app takes `CFBundleShortVersionString` from it and Settings → Updates & App shows it.

## Releases and auto-update

There is no update server: Glide reads GitHub Releases.

1. `pnpm release` builds `release/Glide-darwin-arm64.zip` (made with `ditto -c -k --keepParent`) and `release/Glide-darwin-arm64.zip.sha256`.
2. Create a GitHub release tagged `vX.Y.Z` (matching `package.json`) and attach both files with exactly those names.
3. In Settings → Updates & App, set **Update feed** to `owner/repo`. With an empty feed updates are off and Glide makes no update requests.

With a feed set, Glide checks `https://api.github.com/repos/<owner>/<repo>/releases/latest` on start and every 6 hours (unless "Check automatically" is off), ignores drafts and prereleases, and when the tag is newer it adds "Update Glide to vX.Y.Z" to the launcher and posts a notification. Installing downloads the zip, checks its SHA-256 against the `.sha256` asset, unpacks it with `ditto -x -k`, requires `codesign --verify --deep --strict` to pass and the bundle identifier and version to match, moves the running Glide.app to the Trash, moves the new one into its place and relaunches. Any failed check leaves the installed app untouched.

An ad-hoc signed update still passes these checks, but Gatekeeper will quarantine-prompt a downloaded ad-hoc build on other Macs; notarize releases you hand to other people.

## Notarization (needs a paid Apple Developer account)

```sh
APPLE_ID=you@example.com APPLE_TEAM_ID=ABCDE12345 APPLE_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx \
  pnpm release && pnpm notarize
```

`scripts/notarize.mjs` signs every nested binary inside-out with your "Developer ID Application" identity, hardened runtime and `build/entitlements.mac.plist` (JIT and unsigned executable memory for V8, Apple Events, Calendars; the helper gets `build/entitlements.helper.plist`), submits with `xcrun notarytool submit --wait`, staples, checks with `spctl`, and rebuilds the release zip and checksum. Set `APPLE_SIGN_IDENTITY` if you have several identities. Without the credentials and identity it lists what is missing and exits without changing anything.

## Data

Settings → Updates & App can show the data folder, export or import `data.json` through a save/open dialog, and reset Glide to defaults. Import and reset first write a backup to `~/Library/Application Support/Glide/backups/`.

## Stable local signing (recommended)

Ad-hoc signatures change on every build, and macOS ties privacy grants (Accessibility, Input Monitoring, keychain access) to the signature, so each rebuild would ask again. Run once:

```sh
node scripts/setup-signing.mjs
```

It creates a self-signed "Glide Local Signing" identity in its own keychain (`~/Library/Keychains/glide-signing.keychain-db`) and trusts it for code signing only; macOS asks you to approve that. `pnpm install:app` then signs with it automatically, and grants survive rebuilds.
