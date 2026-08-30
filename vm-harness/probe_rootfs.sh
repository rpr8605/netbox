#!/usr/bin/env bash
# vm-harness/probe_rootfs.sh — list kernel/initrd filenames as flashed into
# ROOTFS_A. Diagnoses 'you need to load the kernel first' by showing the true
# path referenced from grub.embed.cfg.
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
mount -o ro "/dev/mapper/$(basename "$LOOP")p3" "$TM"
echo "== / =="; ls -l "$TM/root" | grep -E "vmlinuz|initrd|boot|sbin" || true
echo "== /boot =="; ls -l "$TM/root/boot" | head -20 || true
echo "== /sbin =="; ls -l "$TM/root/sbin" | head -5 || true
echo "== /usr/sbin/init =="; ls -l "$TM/root/usr/sbin/init" || true
umount "$TM"
kpartx -dv "$LOOP" >/dev/null 2>&1 || true
losetup -d "$LOOP"
