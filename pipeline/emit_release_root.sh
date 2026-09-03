#!/usr/bin/env bash
# pipeline/emit_release_root.sh — emit (if absent) a dedicated RELEASE-signing
# EC P-256 key + self-signed X.509 root that is intentionally SEPARATE from the
# device-enrollment trust root (step-ca). Keys land under the /out mount
# (release-sign/build/ subdir) which compose passes from host, so the private
# key never enters the worker image and never ships in the .gitignore'd tree.
# Idempotent: rotation is manual (nuke dir, re-run).
set -euo pipefail
DEST=/out/release-sign/build
KEY=$DEST/signing.key
CRT=$DEST/signing.crt
mkdir -p "$DEST"
if [ -f "$KEY" ] && [ -f "$CRT" ]; then
  echo "release-signing root already present: $CRT (no-op)"
  exit 0
fi
openssl ecparam -genkey -name prime256v1 -noout -out "$KEY"
openssl req -new -x509 -key "$KEY" -days 3650 \
  -subj '/CN=netbox-release-offline-root/O=netbox/C=US' -out "$CRT"
echo "emitted release-signing root: private=$KEY public=$CRT"
