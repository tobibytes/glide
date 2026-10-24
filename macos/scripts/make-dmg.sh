#!/bin/zsh
# Package build/Glide.app into build/Glide-<version>.dmg (+ .sha256): Glide.app, an Applications link and
# "Read Me First.txt". hdiutil builds the image from a staging folder (-srcfolder): nothing is mounted in
# Finder and nothing is launched or installed.
#
#   scripts/make-dmg.sh                     # packages the existing build/Glide.app (scripts/build-app.sh)
#   scripts/make-dmg.sh --arch universal    # builds first (scripts/build-app.sh --arch …), then packages
#   scripts/make-dmg.sh --arch arm64        # Apple-silicon-only build → Glide-<version>-arm64.dmg
#   GLIDE_APP=/path/Glide.app GLIDE_OUT=/dir scripts/make-dmg.sh
#
# The DMG is named Glide-<version>.dmg when the app is universal (the default build-app.sh output, runs on Apple
# silicon and Intel) and Glide-<version>-<arch>.dmg for a single-architecture app.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
BUILD_ARCH=
while (( $# )); do
  case $1 in
    --arch) [[ $# -ge 2 ]] || { echo "--arch needs a value (arm64, x86_64, universal)" >&2; exit 2; }; BUILD_ARCH=$2; shift 2 ;;
    --arch=*) BUILD_ARCH=${1#--arch=}; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
if [[ -n $BUILD_ARCH ]]; then
  [[ -z ${GLIDE_APP:-} ]] || { echo "--arch builds build/Glide.app; don't combine it with GLIDE_APP" >&2; exit 2; }
  "$ROOT/scripts/build-app.sh" --arch "$BUILD_ARCH"
fi
APP=${GLIDE_APP:-$ROOT/build/Glide.app}
OUT=${GLIDE_OUT:-$ROOT/build}
[[ -d $APP && -f $APP/Contents/Info.plist ]] || { echo "no app at $APP (run scripts/build-app.sh first)" >&2; exit 1; }
VERSION=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist" 2>/dev/null || echo 0.0.0)
MIN_OS=$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' "$APP/Contents/Info.plist" 2>/dev/null || echo 14.0)
ARCHS=(${(o)=$(lipo -archs "$APP/Contents/MacOS/Glide")})
case "${ARCHS[*]}" in
  "arm64 x86_64") SUFFIX=; CHIPS="Apple silicon (M1 and later) and Intel Macs" ;;
  "arm64") SUFFIX=-arm64; CHIPS="Apple silicon Macs (M1 and later) only — this build does not run on Intel Macs" ;;
  "x86_64") SUFFIX=-x86_64; CHIPS="Intel Macs (Apple silicon Macs run it through Rosetta)" ;;
  *) echo "unexpected architectures in $APP: ${ARCHS[*]}" >&2; exit 1 ;;
esac
NAME="Glide-$VERSION$SUFFIX.dmg"
DMG=$OUT/$NAME
STAGE=$(mktemp -d "${TMPDIR:-/tmp}/glide-dmg.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$OUT"

ditto "$APP" "$STAGE/Glide.app"
ln -s /Applications "$STAGE/Applications"
NOTARIZED=0
xcrun stapler validate "$APP" >/dev/null 2>&1 && NOTARIZED=1
if (( NOTARIZED )); then
cat > "$STAGE/Read Me First.txt" <<TXT
Installing Glide $VERSION
================$(printf '%*s' ${#VERSION} '' | tr ' ' '=')=

Runs on: $CHIPS, macOS $MIN_OS or later.

1. Drag Glide onto the Applications folder.
2. Open Glide from Applications.

Glide then shows a short setup: pick a hotkey (⌥Space by default) and grant the permissions
you want. Everything stays on your Mac. Glide updates itself from GitHub Releases.

Source, docs and updates: https://github.com/tobibytes/glide
TXT
else
cat > "$STAGE/Read Me First.txt" <<TXT
Installing Glide $VERSION
================$(printf '%*s' ${#VERSION} '' | tr ' ' '=')=

Runs on: $CHIPS, macOS $MIN_OS or later.

1. Drag Glide onto the Applications folder.
2. Open Glide from Applications.

The first time, macOS says Glide "can't be opened" / "Apple could not verify Glide", because it isn't
from the App Store or notarized by Apple. Allow it once:

  macOS 15 Sequoia, macOS 26 and later
    1. Open Glide and click Done on the warning.
    2. System Settings → Privacy & Security → scroll down to Security →
       "Glide was blocked to protect your Mac." → Open Anyway.
    3. Enter your password, then click Open Anyway in the next dialog.
    (Control-click → Open no longer skips this check on these versions.)

  macOS 14 Sonoma
    Control-click Glide in Applications → Open → Open. (Or use Privacy & Security → Open Anyway as above.)

  Or, on any version, in Terminal (after copying to Applications):
    xattr -dr com.apple.quarantine /Applications/Glide.app

Glide then shows a short setup: pick a hotkey (⌥Space by default) and grant the permissions
you want. Everything stays on your Mac.

Source, docs and updates: https://github.com/tobibytes/glide
TXT
fi

rm -f "$DMG"
hdiutil create -quiet -volname Glide -srcfolder "$STAGE" -fs HFS+ -format UDZO -imagekey zlib-level=9 -ov "$DMG"
hdiutil verify -quiet "$DMG"
SHA=$(shasum -a 256 "$DMG" | cut -d' ' -f1)
echo "$SHA  $NAME" > "$DMG.sha256"
echo "==> $DMG ($(du -h "$DMG" | cut -f1), ${ARCHS[*]}) sha256 $SHA"
