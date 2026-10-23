#!/bin/zsh
# Package build/Glide.app into build/Glide-<version>.dmg (+ .sha256): Glide.app, an Applications link and
# "Read Me First.txt". hdiutil builds the image from a staging folder (-srcfolder): nothing is mounted in
# Finder and nothing is launched or installed.
#
#   scripts/make-dmg.sh                     # uses build/Glide.app (scripts/build-app.sh)
#   GLIDE_APP=/path/Glide.app GLIDE_OUT=/dir scripts/make-dmg.sh
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
APP=${GLIDE_APP:-$ROOT/build/Glide.app}
OUT=${GLIDE_OUT:-$ROOT/build}
[[ -d $APP && -f $APP/Contents/Info.plist ]] || { echo "no app at $APP (run scripts/build-app.sh first)" >&2; exit 1; }
VERSION=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist" 2>/dev/null || echo 0.0.0)
NAME="Glide-$VERSION.dmg"
DMG=$OUT/$NAME
STAGE=$(mktemp -d "${TMPDIR:-/tmp}/glide-dmg.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$OUT"

ditto "$APP" "$STAGE/Glide.app"
ln -s /Applications "$STAGE/Applications"
cat > "$STAGE/Read Me First.txt" <<'TXT'
Installing Glide
================

1. Drag Glide onto the Applications folder.
2. Open Glide from Applications.

macOS will say Glide "can't be opened" the first time, because it isn't from the App Store
or notarized by Apple. To allow it (once):

  System Settings → Privacy & Security → scroll down → "Glide was blocked…" → Open Anyway

  or, in Terminal:   xattr -dr com.apple.quarantine /Applications/Glide.app

Glide then shows a short setup: pick a hotkey (⌥Space by default) and grant the permissions
you want. Everything stays on your Mac.

Source, docs and updates: https://github.com/tobibytes/glide
TXT

rm -f "$DMG"
hdiutil create -quiet -volname Glide -srcfolder "$STAGE" -fs HFS+ -format UDZO -imagekey zlib-level=9 -ov "$DMG"
hdiutil verify -quiet "$DMG"
SHA=$(shasum -a 256 "$DMG" | cut -d' ' -f1)
echo "$SHA  $NAME" > "$DMG.sha256"
echo "==> $DMG ($(du -h "$DMG" | cut -f1)) sha256 $SHA"
