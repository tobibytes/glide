#!/bin/zsh
# Build everything (including the Glide executable the E2E tests spawn), then run all tests headless.
# GLIDE_SCRATCH=<dir> uses a private SwiftPM scratch dir (parallel sessions). Extra args go to `swift test`.
# Snapshots go to $GLIDE_SNAPSHOT_DIR (default: $TMPDIR/glide-snapshots).
set -euo pipefail
cd "$(dirname "$0")/.."
SCRATCH_ARGS=()
[[ -n ${GLIDE_SCRATCH:-} ]] && SCRATCH_ARGS=(--scratch-path "$GLIDE_SCRATCH")
swift build "${SCRATCH_ARGS[@]}"
swift test "${SCRATCH_ARGS[@]}" "$@"
