#!/bin/zsh
# Build the release artifacts for a GitHub Release (what the in-app updater consumes):
#   build/Glide-darwin-<arch>.zip (+ .sha256)   — `ditto -c -k --keepParent`, asset names the updater expects
#   build/Glide-<version>.dmg (+ .sha256)       — scripts/make-dmg.sh
#
#   scripts/release.sh                 # build-app.sh (universal) + zip + dmg (nothing is published)
#   scripts/release.sh --arch arm64    # single-architecture build (Glide-darwin-arm64.zip, Glide-<version>-arm64.dmg)
#   scripts/release.sh --skip-build    # package an existing build/Glide.app
#   scripts/release.sh --publish       # also `gh release create v<version>` with the four files (explicit only)
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
APP=$ROOT/build/Glide.app
SKIP_BUILD=0; PUBLISH=0; BUILD_ARGS=()
while (( $# )); do
  case $1 in
    --skip-build) SKIP_BUILD=1; shift ;;
    --publish) PUBLISH=1; shift ;;
    --arch) [[ $# -ge 2 ]] || { echo "--arch needs a value" >&2; exit 2; }; BUILD_ARGS=(--arch "$2"); shift 2 ;;
    --arch=*) BUILD_ARGS=("$1"); shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
(( SKIP_BUILD )) || "$ROOT/scripts/build-app.sh" "${BUILD_ARGS[@]}"
[[ -d $APP ]] || { echo "no $APP" >&2; exit 1; }
codesign --verify --deep --strict "$APP"
VERSION=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")
ARCHS=$(lipo -archs "$APP/Contents/MacOS/Glide")
case $ARCHS in
  "arm64") ARCH=arm64; DMG_SUFFIX=-arm64 ;;
  "x86_64") ARCH=x64; DMG_SUFFIX=-x86_64 ;;
  *arm64*x86_64*|*x86_64*arm64*) ARCH=universal; DMG_SUFFIX= ;;
  *) echo "unexpected archs: $ARCHS" >&2; exit 1 ;;
esac
ZIP_NAME="Glide-darwin-$ARCH.zip"
ZIP=$ROOT/build/$ZIP_NAME
rm -f "$ZIP" "$ZIP.sha256"
ditto -c -k --keepParent "$APP" "$ZIP"
echo "$(shasum -a 256 "$ZIP" | cut -d' ' -f1)  $ZIP_NAME" > "$ZIP.sha256"
echo "==> $ZIP"
GLIDE_APP=$APP "$ROOT/scripts/make-dmg.sh"
DMG=$ROOT/build/Glide-$VERSION$DMG_SUFFIX.dmg
if (( PUBLISH )); then
  command -v gh >/dev/null || { echo "gh is required for --publish" >&2; exit 1; }
  gh release create "v$VERSION" "$ZIP" "$ZIP.sha256" "$DMG" "$DMG.sha256" --title "Glide $VERSION" --generate-notes
else
  echo "Publish: attach $ZIP_NAME(.sha256) and $(basename "$DMG")(.sha256) to a GitHub release tagged v$VERSION (or rerun with --publish)."
fi
