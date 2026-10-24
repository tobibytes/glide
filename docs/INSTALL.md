# Installing, updating and releasing Glide

Glide ships as a native macOS app (Swift, in `macos/`). It runs on Apple silicon and Intel Macs with macOS 14 or later.

## Install

1. Download `Glide-<version>.dmg` from the [latest release](https://github.com/tobibytes/glide/releases/latest) or [glide.madebytobi.com](https://glide.madebytobi.com).
2. Open it and drag **Glide** onto **Applications**.
3. Releases aren't notarized by Apple yet, so the first launch is blocked. Open **System Settings**, then **Privacy & Security**, and click **Open Anyway** next to the message about Glide. (Or in Terminal: `xattr -dr com.apple.quarantine /Applications/Glide.app`.)
4. Glide walks you through your hotkey (⌥Space by default, or ⌘Space), permissions, an optional AI key and a theme.

Glide is a menu-bar app with no Dock icon (Settings and AI Chat show one while they're open). Turn on **Launch at login** in Settings, then **Updates & App**.

### Permissions

macOS asks when a feature first needs one:

| Permission | Used for |
| --- | --- |
| Accessibility | window management, menu search, pasting, selected text, phone remote control |
| Input Monitoring | snippets that expand as you type, the Hyper key |
| Screen & System Audio Recording | Capture Text and Scan QR Code (take effect after Glide restarts) |
| Calendars, Reminders | your schedule and reminders |
| Local Network | Glide on iPhone, only when you turn it on |
| Full Disk Access (optional) | Safari bookmarks and history |

## Updates

Glide reads GitHub Releases; there is no update server. It checks 15 seconds after it starts and every 6 hours (turn this off in Settings, then **Updates & App**), and when you open Settings or About if it hasn't checked in the last hour.

To check yourself, use any of these:

- **Settings → About**: says "Glide is up to date" or which version is available, with **Check for Updates** and **Update** buttons.
- **Settings → Updates & App → Check Now**: shows progress, the result and when it last checked.
- **Check for Updates…** in Glide's menu bar menu.
- Type `update glide` in the launcher when an update is available.

What the updater does: it picks the build for your Mac (`Glide-darwin-arm64.zip` or `Glide-darwin-x64.zip` if present, otherwise `Glide-darwin-universal.zip`, always with its `.sha256`), downloads it, checks the SHA-256, unpacks it, requires a valid code signature with the same bundle identifier and the expected version, moves the old Glide.app to the Trash, puts the new one in its place, and restarts Glide. Any failed check leaves the installed app untouched.

The update feed is `tobibytes/glide`; change it in Settings, then **Updates & App**. An empty feed turns updates off, and Glide then makes no update requests.

> Updating from 0.4.0 or 0.4.1: those versions could hang on "Installing… done" instead of restarting. The update is already installed; force quit Glide in Activity Monitor and open it again. Fixed in 0.4.2.

## Uninstall

Quit Glide, delete `/Applications/Glide.app`, and delete `~/Library/Application Support/Glide`.

## Build from source

Requirements: macOS 14 or later and Xcode 16 (or the Swift 6 toolchain). There are no third-party dependencies.

```sh
git clone https://github.com/tobibytes/glide.git && cd glide/macos
swift build                    # debug build
scripts/test.sh                # builds, then runs every test headless (nothing appears on screen)
scripts/build-app.sh           # universal release app in build/Glide.app, signed (--arch arm64 for one slice)
scripts/make-dmg.sh            # build/Glide-<version>.dmg (+ .sha256)
```

Copy `build/Glide.app` to `/Applications` to use it. See [macos/README.md](../macos/README.md) for the code layout and the headless test server.

### Stable local signing (recommended)

macOS ties privacy grants (Accessibility, Input Monitoring, Screen Recording) to the app's signature. Ad-hoc signatures change on every build, so each rebuild would ask again. Run once from the repository root:

```sh
node scripts/setup-signing.mjs
```

It creates a self-signed "Glide Local Signing" identity in its own keychain (`~/Library/Keychains/glide-signing.keychain-db`). `build-app.sh` then signs with it automatically, so grants survive rebuilds and updates. Set `GLIDE_SIGN_IDENTITY` to sign with another identity, such as a Developer ID.

## Releasing

The version comes from `version` in the root `package.json` (or `GLIDE_VERSION`). To cut a release:

```sh
# bump "version" in package.json, commit and push, then:
macos/scripts/release.sh --publish
```

It builds the universal app, signs it with the local identity, and creates the GitHub release `vX.Y.Z` with `Glide-darwin-universal.zip`, `Glide-<version>.dmg` and their `.sha256` files. Without `--publish` it only builds them in `macos/build/`. Sign every release with the same identity, so people's privacy grants carry over to the new version.

Notarization needs a paid Apple Developer account and isn't scripted for the native app yet.

## The earlier Electron version

The original Electron app is still in `src/` for reference (`pnpm` scripts, `.github/workflows/release.yml` as a manual dry run). It is no longer released.
