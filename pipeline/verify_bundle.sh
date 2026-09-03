#!/usr/bin/env bash
# pipeline/verify_bundle.sh — verify the signed netbox.raucb against the
# release-signing keyring (public cert, same as embedded – intentionally not
# using a second source-of-truth) via `rauc info --keyring`. Device-side
# counter is `rauc verify`, which requires a daemon; on the worker the CLI
# `rauc info --keyring` co-matches the CMS chain.
#
# RAUC 1.8 behavior that shapes this check (verified live): without a keyring,
# `rauc info` SKIPS verification entirely — it does NOT print "signature
# invalid". So the negative assertion is "no 'Verified' line", not a rejection
# string.
set -euo pipefail
VERSION=${1:?usage: verify_bundle.sh <version>}
BUNDLE=/out/$VERSION/netbox.raucb
CRT=/out/release-sign/build/signing.crt
[ -f "$BUNDLE" ] || { echo "missing bundle: $BUNDLE" >&2; exit 1; }
[ -f "$CRT" ] || { echo "missing keyring cert: $CRT" >&2; exit 1; }

# rauc(1.8) mmap's the bundle; the bind-mounted /out is DrvFS from Windows,
# which RAUC rejects as "unknown filesystem (type=1021997)". Copy to
# container-local storage before verifying — the CMS check is content-only.
WORK=$(mktemp -d)
cp "$BUNDLE" "$WORK/netbox.raucb"
BUNDLE="$WORK/netbox.raucb"

echo "== verify: no keyring must NOT show a verified signature =="
OUT_UNVERIFIED=$(rauc info "$BUNDLE" 2>&1 || true)
if echo "$OUT_UNVERIFIED" | grep -q 'Verified'; then
  echo "FAIL: bundle appeared verified without a keyring" >&2; exit 1
else
  echo "OK: no verification claimed without keyring"
fi

echo "== verify: keyring check must verify against the release root =="
# Capture before grep: with pipefail, `grep -q` can SIGPIPE rauc into a
# non-zero exit and the assertion would flip on a successful verify.
OUT_KEYRING=$(rauc info --keyring "$CRT" "$BUNDLE" 2>&1 || true)
echo "$OUT_KEYRING" | grep -E 'Verified|Compatible|Version|Bundle Format'
echo "$OUT_KEYRING" | grep -q 'Verified' || { echo "FAIL: keyring did not verify the bundle" >&2; exit 1; }
echo "VERIFY OK"
