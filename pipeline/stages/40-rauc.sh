#!/usr/bin/env bash
# pipeline/stages/40-rauc.sh — RAUC bundle emission. Two halves:
#   (a) on-image /etc/rauc/system.conf generated from the partition map, and
#   (b) bundle emission into /out/<version>/ as a REAL RAUC .raucb container:
#       the manifest, payload, and the release-signing keyring cert (public
#       only) are packed via `rauc bundle` here; a separate detached-signing
#       step runs AFTER this stage over the assembled container. Private key
#       never enters the image; keyring carries only the public cert.
set -euo pipefail
TARGET=$1
VERSION=${RELEASE_VERSION:-0.1.0}

# --- (a) on-image rauc system.conf ------------------------------------------
mkdir -p "$TARGET/etc/rauc"
cat > "$TARGET/etc/rauc/system.conf" <<EOF
[system]
compatible=beacon-relay-n1xx
bootloader=grub
# mountprefix must be on a WRITABLE fs: the rootfs mounts ro (fstab), so
# /tmp/rauc would EROFS on-device and every install would fail. /run is tmpfs.
mountprefix=/run/rauc
# RAUC's grub backend reads/writes boot state here via grub-editenv (verified
# against RAUC src/bootloaders/grub.c). The ESP is mounted at /boot/efi by
# decrypt-data.service; grub reads the same file as (hd0,gpt1)/grub/grubenv.
grubenv=/boot/efi/grub/grubenv

EOF
# Slot devices use GPT PARTLABELs, not FS labels: RAUC rewrites slot contents
# on update, and by-label (a filesystem label) can change or collide after an
# install; the GPT partition name is stable for the disk's lifetime. bootname
# is what grub's ORDER/<name>_OK/<name>_TRY variables key on (RAUC docs).
jq -r '.partitions | to_entries[] | select(.value.role | startswith("rauc-slot")) |
  "[slot.\(.value.role | ltrimstr("rauc-slot-"))]\ndevice=/dev/disk/by-partlabel/\(.value.label)\ntype=ext4\nbootname=\(.value.bootname)\n"' \
  /work/pipeline/manifests/beacon-relay-partition-map.json \
  >> "$TARGET/etc/rauc/system.conf"

# --- (b) pack bundle container: manifest + payload + public keyring ---------
OUT=/out/$VERSION
mkdir -p "$OUT/manifest" "$OUT/payload" "$OUT/certs"

# The device-side verify gate (lib/update.js verifyBundle) needs the release
# root's PUBLIC cert on the rootfs at /etc/beacon-relay-release-root.crt —
# it was never staged before, so on-device `rauc info --keyring` could only
# ever fail. Stage it BEFORE packing the payload (it ships inside the image).
SIGNING_DIR=/out/release-sign/build
if [ ! -f "$SIGNING_DIR/signing.key" ] || [ ! -f "$SIGNING_DIR/signing.crt" ]; then
  echo "missing release-signing key pair in $SIGNING_DIR (run emit_release_root.sh)" >&2
  exit 1
fi
install -m 0444 "$SIGNING_DIR/signing.crt" "$TARGET/etc/beacon-relay-release-root.crt"

# REAL ext4 filesystem image, sized to the slot exactly. RAUC raw-writes the
# payload to the inactive slot, so the payload must itself be a mountable
# ext4 image — the previous mksquashfs output could never have booted as an
# ext4 slot (the "bundle builds + verifies" milestone never ran an install).
truncate -s 2G "$OUT/payload/rootfs.ext4"
mkfs.ext4 -q -F -L beacon-relay-rootfs -d "$TARGET" "$OUT/payload/rootfs.ext4"
sed "s/__RELEASE_VERSION__/$VERSION/" \
  /work/pipeline/manifests/beacon-relay-rauc.manifest > "$OUT/manifest/manifest.raucm"

# rauc bundle expects a FLAT packdir: manifest.raucm + rootfs.ext4 at the top
# level (RAUC 1.8 reads "<packdir>/manifest.raucm" literally — nesting under
# manifest/ subdirs was the "No such file or directory" failure). The signing
# cert/key pair comes from emit_release_root.sh (build.js step 1) and is used
# ONLY at pack time here; the private key never enters the image. Device-side
# `rauc verify` checks the CMS signature against the release root.
# (SIGNING_DIR was already existence-checked above, before the cert staging.)
PACKDIR=$(mktemp -d)
cp "$OUT/payload/rootfs.ext4" "$PACKDIR/rootfs.ext4"
cp "$OUT/manifest/manifest.raucm" "$PACKDIR/manifest.raucm"
# rauc bundle refuses to overwrite; stages must be idempotent (executor contract)
rm -f "$OUT/beacon-relay.raucb"
rauc bundle \
  --cert="$SIGNING_DIR/signing.crt" \
  --key="$SIGNING_DIR/signing.key" \
  "$PACKDIR" "$OUT/beacon-relay.raucb" 2>/tmp/rauc_bundle.log || {
  echo "rauc bundle failed: $(cat /tmp/rauc_bundle.log)" >&2; exit 1; }
rm -rf "$PACKDIR"

sha256sum "$OUT/beacon-relay.raucb" > "$OUT/SHA256SUMS"
echo "bundle assembled: $OUT/beacon-relay.raucb (CMS signed with release root)"
