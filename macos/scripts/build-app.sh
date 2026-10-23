#!/bin/zsh
# Build the native Glide.app (release) into macos/build/Glide.app and sign it.
#
#   scripts/build-app.sh                 # arm64 release build, signed, verified
#   GLIDE_SCRATCH=/path scripts/build-app.sh   # SwiftPM --scratch-path (parallel sessions use their own)
#   GLIDE_ARCH=universal scripts/build-app.sh  # TODO: universal (arm64 + x86_64) — see below
#   GLIDE_SIGN_IDENTITY="Developer ID Application: …" scripts/build-app.sh
#
# Signing mirrors ../scripts/package.mjs: the stable "Glide Local Signing" identity in
# ~/Library/Keychains/glide-signing.keychain-db (password in ~/.config/glide/signing-keychain-password) keeps
# macOS privacy grants (Accessibility, Automation, …) across rebuilds; otherwise ad-hoc ("-").
# The bundle id is dev.glide.launcher — the same as the Electron app — so data and permissions carry over.
#
# This script never installs or launches the app. Run it headless via the test server (docs/TESTING.md):
#   GLIDE_HEADLESS=1 GLIDE_USER_DATA=$(mktemp -d) build/Glide.app/Contents/MacOS/Glide --test-server
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
SCRATCH=${GLIDE_SCRATCH:-$ROOT/.build}
ARCH=${GLIDE_ARCH:-arm64}
OUT=$ROOT/build
APP=$OUT/Glide.app
ICON=$ROOT/../build/icon.icns
VERSION=${GLIDE_VERSION:-$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$ROOT/../package.json" | head -1)}
VERSION=${VERSION:-0.0.0}
BUILD_NUMBER=${GLIDE_BUILD_NUMBER:-$(date +%Y%m%d%H%M)}

case $ARCH in
  arm64) ARCH_FLAGS=(--arch arm64) ;;
  x86_64) ARCH_FLAGS=(--arch x86_64) ;;
  universal)
    # TODO(universal): `swift build --arch arm64 --arch x86_64` builds through xcbuild into
    # <scratch>/apple/Products/Release; untested here (no x86_64 toolchain verification yet).
    ARCH_FLAGS=(--arch arm64 --arch x86_64) ;;
  *) echo "unknown GLIDE_ARCH=$ARCH (arm64, x86_64, universal)" >&2; exit 2 ;;
esac

echo "==> swift build -c release ${ARCH_FLAGS[*]} (scratch: $SCRATCH)"
swift build -c release --product Glide --scratch-path "$SCRATCH" "${ARCH_FLAGS[@]}"
BIN_DIR=$(swift build -c release --product Glide --scratch-path "$SCRATCH" "${ARCH_FLAGS[@]}" --show-bin-path)
BIN=$BIN_DIR/Glide
[[ -x $BIN ]] || { echo "no binary at $BIN" >&2; exit 1; }

echo "==> assembling $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/Glide"
# SwiftPM resource bundles (none today; future targets with resources).
for b in "$BIN_DIR"/*.bundle(N); do
  [[ $(basename "$b") == *Tests* ]] && continue
  cp -R "$b" "$APP/Contents/Resources/"
done
if [[ -f $ICON ]]; then cp "$ICON" "$APP/Contents/Resources/icon.icns"; else echo "warning: $ICON not found; no app icon" >&2; fi

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>Glide</string>
  <key>CFBundleIdentifier</key><string>dev.glide.launcher</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Glide</string>
  <key>CFBundleDisplayName</key><string>Glide</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$BUILD_NUMBER</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
  <key>LSUIElement</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSSupportsAutomaticGraphicsSwitching</key><true/>
  <key>NSHumanReadableCopyright</key><string>© 2026 tobibytes · MIT License</string>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key><string>dev.glide.launcher</string>
      <key>CFBundleURLSchemes</key><array><string>glide</string></array>
    </dict>
  </array>
  <key>NSAppleEventsUsageDescription</key><string>Glide runs your workflows and scripts, and controls apps you ask it to (Music, Finder, System Events).</string>
  <key>NSRemindersUsageDescription</key><string>Glide shows and creates reminders from the launcher.</string>
  <key>NSRemindersFullAccessUsageDescription</key><string>Glide shows and creates reminders from the launcher.</string>
  <key>NSCalendarsUsageDescription</key><string>Glide shows your upcoming events and lets you join meetings.</string>
  <key>NSCalendarsFullAccessUsageDescription</key><string>Glide shows your upcoming events and lets you join meetings.</string>
  <key>NSLocationUsageDescription</key><string>Glide uses your location for weather and the Wi-Fi network name.</string>
  <key>NSLocationWhenInUseUsageDescription</key><string>Glide uses your location for weather and the Wi-Fi network name.</string>
  <key>NSDesktopFolderUsageDescription</key><string>Glide searches files on your Desktop.</string>
  <key>NSDocumentsFolderUsageDescription</key><string>Glide searches files in your Documents folder.</string>
  <key>NSDownloadsFolderUsageDescription</key><string>Glide searches files in your Downloads folder.</string>
  <key>NSScreenCaptureUsageDescription</key><string>Glide reads text on screen (OCR) and picks colors when you ask it to.</string>
</dict>
</plist>
PLIST
printf 'APPL????' > "$APP/Contents/PkgInfo"
plutil -lint "$APP/Contents/Info.plist" >/dev/null

# --- signing -------------------------------------------------------------------------------------------
SIGN_ID="-"
SIGN_ARGS=()
KEYCHAIN=$HOME/Library/Keychains/glide-signing.keychain-db
PASSFILE=$HOME/.config/glide/signing-keychain-password
if [[ -n ${GLIDE_SIGN_IDENTITY:-} ]]; then
  SIGN_ID=$GLIDE_SIGN_IDENTITY
elif [[ -f $KEYCHAIN && -f $PASSFILE ]]; then
  if security unlock-keychain -p "$(tr -d '\n' < "$PASSFILE")" "$KEYCHAIN" 2>/dev/null \
     && security find-identity -v -p codesigning "$KEYCHAIN" 2>/dev/null | grep -q '"Glide Local Signing"'; then
    SIGN_ID="Glide Local Signing"
    SIGN_ARGS=(--keychain "$KEYCHAIN")
  else
    echo "warning: Glide Local Signing unavailable; signing ad-hoc" >&2
  fi
fi
echo "==> codesign ($SIGN_ID)"
codesign --force --options runtime --timestamp=none --sign "$SIGN_ID" "${SIGN_ARGS[@]}" \
  --identifier dev.glide.launcher --entitlements "$ROOT/scripts/Glide.entitlements" "$APP"
codesign --verify --deep --strict "$APP"
echo "==> verified: $(codesign -dv "$APP" 2>&1 | grep -E '^(Identifier|Authority|Signature)=' | head -3 | tr '\n' ' ')"
echo "==> $APP ($(du -sh "$APP" | cut -f1), binary $(du -h "$APP/Contents/MacOS/Glide" | cut -f1), $(lipo -archs "$APP/Contents/MacOS/Glide"))"
