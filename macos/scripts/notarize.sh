#!/bin/zsh
# Notarize and staple Glide.app or a Glide DMG with Apple's notary service.
#   scripts/notarize.sh build/Glide.app
#   scripts/notarize.sh build/Glide-<version>.dmg      # signs the DMG with the Developer ID first
# Needs a "Developer ID Application" certificate in the login keychain and notarytool credentials saved once with:
#   xcrun notarytool store-credentials glide-notary --apple-id <you@example.com> --team-id <TEAMID>
# (it asks for an app-specific password from appleid.apple.com and keeps it in the Keychain).
# Profile name: GLIDE_NOTARY_PROFILE (default "glide-notary").
set -euo pipefail
TARGET=${1:?usage: notarize.sh <Glide.app | Glide.dmg>}
PROFILE=${GLIDE_NOTARY_PROFILE:-glide-notary}
DEVID=$(security find-identity -v -p codesigning 2>/dev/null | sed -nE 's/.*"(Developer ID Application: [^"]+)".*/\1/p' | head -1)
[[ -n $DEVID ]] || { echo "no Developer ID Application certificate in the keychain (see docs/INSTALL.md, Notarization)" >&2; exit 1; }
xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null 2>&1 \
  || { echo "no notarytool credentials named \"$PROFILE\"; run: xcrun notarytool store-credentials $PROFILE --apple-id <id> --team-id <team>" >&2; exit 1; }

WORK=$(mktemp -d "${TMPDIR:-/tmp}/glide-notarize.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

submit() {   # submit <file>: wait for Apple's verdict; print the log and fail unless Accepted
  local out id status
  out=$(xcrun notarytool submit "$1" --keychain-profile "$PROFILE" --wait --output-format json)
  id=$(print -r -- "$out" | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin).get("id",""))')
  status=$(print -r -- "$out" | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin).get("status",""))')
  echo "==> notarization $id: $status"
  if [[ $status != Accepted ]]; then
    [[ -n $id ]] && xcrun notarytool log "$id" --keychain-profile "$PROFILE" >&2 || true
    exit 1
  fi
}

case $TARGET in
  *.app)
    codesign -dv "$TARGET" 2>&1 | grep -q "Authority=Developer ID Application" \
      || { echo "$TARGET is not signed with a Developer ID (rebuild with scripts/build-app.sh)" >&2; exit 1; }
    ditto -c -k --keepParent "$TARGET" "$WORK/Glide.zip"
    submit "$WORK/Glide.zip"
    xcrun stapler staple "$TARGET"
    xcrun stapler validate "$TARGET"
    spctl --assess --type execute -vv "$TARGET"
    ;;
  *.dmg)
    codesign --force --timestamp --sign "$DEVID" "$TARGET"
    submit "$TARGET"
    xcrun stapler staple "$TARGET"
    xcrun stapler validate "$TARGET"
    spctl --assess --type open --context context:primary-signature -vv "$TARGET"
    ;;
  *) echo "expected a .app or .dmg" >&2; exit 2 ;;
esac
echo "==> notarized and stapled: $TARGET"
