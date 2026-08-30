#!/usr/bin/env bash
# vm-harness/debug_unsquashfs.sh — debug helper for squashfs extraction onto a
# loop-backed ext4 block device. Removed once assemble_image.sh is stable.
set -x
VERSION=${1:-0.1.0}
truncate -s 1G "/out/$VERSION/debug.img"
LOOP=$(losetup -f --show "/out/$VERSION/debug.img")
mkfs.ext4 -q -F "$LOOP" >/dev/null
TM=$(mktemp -d)
mount "$LOOP" "$TM"
unsquashfs -f -d "$TM/root" "/out/$VERSION/payload/rootfs.ext4"
echo "rc=$?"
losetup -d "$LOOP"
