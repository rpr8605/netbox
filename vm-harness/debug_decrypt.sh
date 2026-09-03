#!/usr/bin/env bash
# vm-harness/debug_decrypt.sh — probe whether cryptsetup luksFormat/open works
# on the assembled image's DATA partition from within the assemble container.
# Used to isolate why decrypt-data.service fails in QEMU (verified separately).
set -euo pipefail
VERSION=${1:-0.1.0}
cp "/out/$VERSION/netbox-disk.img" /tmp/probe.img
losetup -D >/dev/null 2>&1 || true
LOOP=""
for n in $(seq 0 255); do
  DEV=/dev/loop$n
  [ -b "$DEV" ] || mknod -b 7 "$n" "$DEV" || true
  if losetup "$DEV" /tmp/probe.img 2>/dev/null; then LOOP=$DEV; break; fi
done
[ -z "$LOOP" ] && { echo "no free loop" >&2; exit 1; }
kpartx -av "$LOOP" >/dev/null
BASE=/dev/mapper/$(basename "$LOOP")
TM=$(mktemp -d)
mount "${BASE}p2" "$TM"
dd if=/dev/urandom of=/tmp/probe.key bs=512 count=1 status=none
umount "$TM"
echo "== luksFormat =="
cryptsetup luksFormat --batch-mode "${BASE}p5" /tmp/probe.key 2>&1 | head -5
echo "== open =="
cryptsetup open --key-file /tmp/probe.key "${BASE}p5" test-open 2>&1 | head -5
echo "== close =="
cryptsetup close test-open || true
kpartx -dv "$LOOP" >/dev/null 2>&1 || true
losetup -d "$LOOP"
