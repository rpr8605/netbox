#!/usr/bin/env bash
# pipeline/stages/40-rauc.sh Ã¢â‚¬â€ RAUC enablement. Two halves:
#   (a) on-image /etc/rauc/system.conf generated from the partition map, and
#   (b) bundle emission into /out/<version>/ (manifest + payload + SHA256
#       manifest digest). Signing/verification beyond a digest is performed
#       repo-side by pipeline/rauc_sign.js using the private PKI; the keyring
#       cert ships in the image via the provisioner public key.
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

# --- (b) emit bundle artifacts ----------------------------------------------
OUT=/out/$VERSION
mkdir -p "$OUT/manifest" "$OUT/payload"
mksquashfs "$TARGET" "$OUT/payload/rootfs.ext4" -noappend -comp gzip >/dev/null
sed "s/__RELEASE_VERSION__/$VERSION/" \
  /work/pipeline/manifests/netbox-rauc.manifest > "$OUT/manifest/manifest.raucm"
sha256sum "$OUT/manifest/manifest.raucm" "$OUT/payload/rootfs.ext4" \
  > "$OUT/SHA256SUMS"
echo "bundle assembled under $OUT"

