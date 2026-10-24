#!/bin/zsh
# Build the native Glide.app (release) into macos/build/Glide.app and sign it.
#
#   scripts/build-app.sh                       # universal (arm64 + x86_64) release build, signed, verified
#   scripts/build-app.sh --arch arm64          # one slice only (also x86_64); same as GLIDE_ARCH=arm64
#   GLIDE_SCRATCH=/path scripts/build-app.sh   # SwiftPM --scratch-path (parallel sessions use their own)
#   GLIDE_SIGN_IDENTITY="Developer ID Application: …" scripts/build-app.sh
#
# Universal: each slice is built on its own (`swift build -c release --arch <a>`, same scratch path, separate
# <scratch>/<a>-apple-macosx/release dirs) and joined with `lipo -create`. This avoids SwiftPM's multi-arch
# `--arch arm64 --arch x86_64` path, which goes through xcbuild into a different products layout.
#
# Signing mirrors ../scripts/package.mjs: the stable "Glide Local Signing" identity in
# ~/Library/Keychains/glide-signing.keychain-db (password in ~/.config/glide/signing-keychain-password) keeps
# macOS privacy grants (Accessibility, Automation, …) across rebuilds; otherwise ad-hoc ("-").
# The bundle id is dev.glide.launcher — the same as the Electron app — so data and permissions carry over.
#
# This script never installs or launches the app. Run it headless via the test server (docs/TESTING.md):
#   GLIDE_HEADLESS=1 GLIDE_USER_DATA=$(mktemp -d) build/Glide.app/Contents/MacOS/Glide --test-server
#   (the Intel slice under Rosetta: prefix with `arch -x86_64`)
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
SCRATCH=${GLIDE_SCRATCH:-$ROOT/.build}
ARCH=${GLIDE_ARCH:-universal}
while (( $# )); do
  case $1 in
    --arch) [[ $# -ge 2 ]] || { echo "--arch needs a value (arm64, x86_64, universal)" >&2; exit 2; }; ARCH=$2; shift 2 ;;
    --arch=*) ARCH=${1#--arch=}; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown option $1 (use --arch arm64|x86_64|universal)" >&2; exit 2 ;;
  esac
done
OUT=$ROOT/build
APP=$OUT/Glide.app
ICON=$ROOT/../build/icon.icns
VERSION=${GLIDE_VERSION:-$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$ROOT/../package.json" | head -1)}
VERSION=${VERSION:-0.0.0}
BUILD_NUMBER=${GLIDE_BUILD_NUMBER:-$(date +%Y%m%d%H%M)}

case $ARCH in
  arm64|x86_64) SLICES=($ARCH) ;;
  universal) SLICES=(arm64 x86_64) ;;
  *) echo "unknown arch $ARCH (arm64, x86_64, universal)" >&2; exit 2 ;;
esac

BINS=()
BIN_DIR=
for a in $SLICES; do
  echo "==> swift build -c release --arch $a (scratch: $SCRATCH)"
  swift build -c release --product Glide --scratch-path "$SCRATCH" --arch "$a"
  d=$(swift build -c release --product Glide --scratch-path "$SCRATCH" --arch "$a" --show-bin-path)
  [[ -x $d/Glide ]] || { echo "no binary at $d/Glide" >&2; exit 1; }
  [[ $(lipo -archs "$d/Glide") == "$a" ]] || { echo "$d/Glide is $(lipo -archs "$d/Glide"), expected $a" >&2; exit 1; }
  BINS+=("$d/Glide")
  [[ -n $BIN_DIR ]] || BIN_DIR=$d   # resource bundles are arch-independent; take them from the first slice
done
if (( ${#BINS} > 1 )); then
  BIN=$SCRATCH/Glide-universal
  echo "==> lipo -create ${SLICES[*]}"
  lipo -create "${BINS[@]}" -output "$BIN"
else
  BIN=${BINS[1]}
fi
GOT=(${(o)=$(lipo -archs "$BIN")})
[[ ${GOT[*]} == ${${(o)SLICES}[*]} ]] || { echo "lipo: $BIN is ${GOT[*]}, expected ${SLICES[*]}" >&2; exit 1; }

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
  <key>NSRemovableVolumesUsageDescription</key><string>Glide searches and opens files on external drives you connect.</string>
  <key>NSNetworkVolumesUsageDescription</key><string>Glide searches and opens files on network drives you connect.</string>
  <key>NSLocalNetworkUsageDescription</key><string>Glide lets your paired iPhone use Glide over your Wi-Fi when you turn on Settings, then iPhone.</string>
  <key>NSBonjourServices</key><array><string>_glide._tcp</string></array>
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
DEVID=$(security find-identity -v -p codesigning 2>/dev/null | sed -nE 's/.*"(Developer ID Application: [^"]+)".*/\1/p' | head -1)
if [[ -n ${GLIDE_SIGN_IDENTITY:-} ]]; then
  SIGN_ID=$GLIDE_SIGN_IDENTITY
elif [[ -n $DEVID && ${GLIDE_LOCAL_SIGNING:-0} != 1 ]]; then
  # A Developer ID certificate is installed: releases can be notarized (GLIDE_LOCAL_SIGNING=1 forces the local one).
  SIGN_ID=$DEVID
elif [[ -f $KEYCHAIN && -f $PASSFILE ]]; then
  if security unlock-keychain -p "$(tr -d '\n' < "$PASSFILE")" "$KEYCHAIN" 2>/dev/null \
     && security find-identity -v -p codesigning "$KEYCHAIN" 2>/dev/null | grep -q '"Glide Local Signing"'; then
    SIGN_ID="Glide Local Signing"
    SIGN_ARGS=(--keychain "$KEYCHAIN")
  else
    echo "warning: Glide Local Signing unavailable; signing ad-hoc" >&2
  fi
fi
# Notarization needs Apple's secure timestamp; local and ad-hoc signatures don't (and work offline).
TIMESTAMP=--timestamp=none
[[ $SIGN_ID == "Developer ID Application:"* ]] && TIMESTAMP=--timestamp
echo "==> codesign ($SIGN_ID)"
codesign --force --options runtime $TIMESTAMP --sign "$SIGN_ID" "${SIGN_ARGS[@]}" \
  --identifier dev.glide.launcher --entitlements "$ROOT/scripts/Glide.entitlements" "$APP"
codesign --verify --deep --strict "$APP"
echo "==> verified: $(codesign -dv "$APP" 2>&1 | grep -E '^(Identifier|Authority|Signature)=' | head -3 | tr '\n' ' ')"
echo "==> $APP ($(du -sh "$APP" | cut -f1), binary $(du -h "$APP/Contents/MacOS/Glide" | cut -f1), $(lipo -archs "$APP/Contents/MacOS/Glide"))"
