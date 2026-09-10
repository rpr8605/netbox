#!/usr/bin/env bash
# configurator/flash_wrapper.sh — write out/<version>/beacon-relay-disk.img to a
# target, then verify. Target for dev/CI is a QEMU-compatible raw file; the
# configurator CLI is the only caller and it pre-gates the unmissable confirm.
# Paths resolve from the repo root so this runs identically on the Windows dev
# host (Git bash) and inside the build container (/out mount).
set -euo pipefail
VERSION=${1:?version}
TARGET=${2:?target (dev: a raw file under out/qemu-disk.raw; prod: /dev/sdX)}
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMG="$REPO_ROOT/out/$VERSION/beacon-relay-disk.img"
LOG_SHA=$(sha256sum "$IMG" | awk '{print $1}')

echo "flash: $IMG -> $TARGET"
echo "flash: source sha256=$LOG_SHA"

dd if="$IMG" of="$TARGET" bs=4M conv=fsync status=progress
sync

# Verify the write by hashing back EXACTLY the written region. Without a count,
# dd reads the WHOLE target — on any drive larger than the image that hashes
# garbage past the end and falsely reports a mismatch (or worse, a false match
# is impossible to distinguish). Compute blocks from the image's real size.
IMG_BYTES=$(stat -c %s "$IMG" 2>/dev/null || stat -f %z "$IMG")
BLOCKS=$(( (IMG_BYTES + 4194303) / 4194304 ))  # ceil(bytes / 4M)
ACTUAL_SHA=$(dd if="$TARGET" bs=4M count="$BLOCKS" status=none | sha256sum | awk '{print $1}')
if [ "$ACTUAL_SHA" != "$LOG_SHA" ]; then
  echo "flash: VERIFY FAILED source=$LOG_SHA target=$ACTUAL_SHA" >&2
  exit 1
fi
echo "flash: verified; sha256 matches"
