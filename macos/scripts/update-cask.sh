#!/bin/zsh
# Update the Homebrew cask (tobibytes/homebrew-tap, Casks/glide.rb) to a released version and push it.
#   scripts/update-cask.sh <version> <dmg-path>      # called by release.sh --publish
# The tap checkout defaults to ../../homebrew-tap next to this repository (override with GLIDE_TAP_DIR).
# Skips quietly when there is no tap checkout; never touches anything else.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=${1:?version}
DMG=${2:?dmg path}
TAP=${GLIDE_TAP_DIR:-$PWD/../../homebrew-tap}
CASK=$TAP/Casks/glide.rb
[[ -f $CASK ]] || { echo "==> no Homebrew tap at $TAP (skipping cask update)"; exit 0; }
SHA=$(shasum -a 256 "$DMG" | cut -d' ' -f1)
sed -i '' -E "s/^  version \".*\"/  version \"$VERSION\"/; s/^  sha256 \".*\"/  sha256 \"$SHA\"/" "$CASK"
git -C "$TAP" add Casks/glide.rb
if git -C "$TAP" diff --cached --quiet; then echo "==> cask already at $VERSION"; exit 0; fi
git -C "$TAP" commit -q -m "glide $VERSION"
if git -C "$TAP" remote get-url origin >/dev/null 2>&1; then
  git -C "$TAP" push -q origin HEAD && echo "==> pushed cask glide $VERSION"
else
  echo "==> cask updated to $VERSION locally (no remote yet)"
fi
