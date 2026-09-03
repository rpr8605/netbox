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
source /tmp/partition.env
VERSION=${RELEASE_VERSION:-0.1.0}

# --- (a) on-image rauc system.conf ------------------------------------------
mkdir -p "$TARGET/etc/rauc"
cat > "$TARGET/etc/rauc/system.conf" <<EOF
[system]
compatible=netbox-n1xx
bootloader=grub
mountprefix=/tmp/rauc

EOF
jq -r '.partitions | to_entries[] | select(.value.role | startswith("rauc-slot")) |
  "[slot.\(.value.role | ltrimstr("rauc-slot-"))]\ndevice=/dev/disk/by-label/\(.value.label)\ntype=ext4\n"' \
  /work/pipeline/manifests/netbox-partition-map.json \
  >> "$TARGET/etc/rauc/system.conf"

# --- (b) pack bundle container: manifest + payload + public keyring ---------
OUT=/out/$VERSION
mkdir -p "$OUT/manifest" "$OUT/payload" "$OUT/certs"
mksquashfs "$TARGET" "$OUT/payload/rootfs.ext4" -noappend -comp gzip >/dev/null
sed "s/__RELEASE_VERSION__/$VERSION/" \
  /work/pipeline/manifests/netbox-rauc.manifest > "$OUT/manifest/manifest.raucm"

# rauc bundle expects a FLAT packdir: manifest.raucm + rootfs.ext4 at the top
# level (RAUC 1.8 reads "<packdir>/manifest.raucm" literally — nesting under
# manifest/ subdirs was the "No such file or directory" failure). The signing
# cert/key pair comes from emit_release_root.sh (build.js step 1) and is used
# ONLY at pack time here; the private key never enters the image. Device-side
# `rauc verify` checks the CMS signature against the release root.
SIGNING_DIR=/out/release-sign/build
if [ ! -f "$SIGNING_DIR/signing.key" ] || [ ! -f "$SIGNING_DIR/signing.crt" ]; then
  echo "missing release-signing key pair in $SIGNING_DIR (run emit_release_root.sh)" >&2
  exit 1
fi

PACKDIR=$(mktemp -d)
cp "$OUT/payload/rootfs.ext4" "$PACKDIR/rootfs.ext4"
cp "$OUT/manifest/manifest.raucm" "$PACKDIR/manifest.raucm"
# rauc bundle refuses to overwrite; stages must be idempotent (executor contract)
rm -f "$OUT/netbox.raucb"
rauc bundle \
  --cert="$SIGNING_DIR/signing.crt" \
  --key="$SIGNING_DIR/signing.key" \
  "$PACKDIR" "$OUT/netbox.raucb" 2>/tmp/rauc_bundle.log || {
  echo "rauc bundle failed: $(cat /tmp/rauc_bundle.log)" >&2; exit 1; }
rm -rf "$PACKDIR"

sha256sum "$OUT/netbox.raucb" > "$OUT/SHA256SUMS"
echo "bundle assembled: $OUT/netbox.raucb (CMS signed with release root)"
