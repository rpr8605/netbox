#!/usr/bin/env bash
# vm-harness/probe_esp.sh — inspect the ESP partition of a built disk image.
# Reports embedded cfg presence/contents so VM boot failures are checked
# with data, not guesses. Keep as a permanent pipeline diagnostic.
set -euo pipefail
VERSION=${1:?version}
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
TM=$(mktemp -d)
mount "/dev/mapper/$(basename "$LOOP")p1" "$TM"
echo "== ESP files =="; ls -lR "$TM"
echo "== embedded cfg grep =="
grep -a -E "gpt3|ROOTFS_A|search|normal|timeout" "$TM/EFI/BOOT/BOOTX64.EFI" | head -10 || true
umount "$TM"
kpartx -dv "$LOOP" >/dev/null 2>&1 || true
losetup -d "$LOOP"
