#!/usr/bin/env bash
# configurator/flash_wrapper.sh — write out/<version>/netbox-disk.img to a
# target, then verify. Target for dev/CI is a QEMU-compatible raw file; the
# configurator CLI is the only caller and it pre-gates the unmissable confirm.
# Paths resolve from the repo root so this runs identically on the Windows dev
# host (Git bash) and inside the build container (/out mount).
set -euo pipefail
VERSION=${1:?version}
TARGET=${2:?target (dev: a raw file under out/qemu-disk.raw; prod: /dev/sdX)}
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMG="$REPO_ROOT/out/$VERSION/netbox-disk.img"
LOG_SHA=$(sha256sum "$IMG" | awk '{print $1}')

echo "flash: $IMG -> $TARGET"
echo "flash: source sha256=$LOG_SHA"

dd if="$IMG" of="$TARGET" bs=4M conv=fsync status=progress
sync

# Verify the write by hashing the target back. dd-into-file on Windows-host
# loop shares the same content path so this catches transport/echo corruption.
ACTUAL_SHA=$(dd if="$TARGET" bs=4M status=none | sha256sum | awk '{print $1}')
if [ "$ACTUAL_SHA" != "$LOG_SHA" ]; then
  echo "flash: VERIFY FAILED source=$LOG_SHA target=$ACTUAL_SHA" >&2
  exit 1
fi
echo "flash: verified; sha256 matches"
