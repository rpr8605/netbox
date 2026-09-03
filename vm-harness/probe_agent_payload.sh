#!/usr/bin/env bash
# vm-harness/probe_agent_payload.sh — mount the built squashfs payload
# (out/<version>/payload/rootfs.ext4) read-only and list the agent tree that
# was actually packed into the image. This is the ground-truth check for the
# "signal code missing from built image" bug: it reads the REAL artifact, not
# a build log. Usage: probe_agent_payload.sh <version>   (default 0.1.0)
set -euo pipefail
VERSION=${1:-0.1.0}
IMG="/out/$VERSION/payload/rootfs.ext4"
[ -f "$IMG" ] || { echo "payload not found: $IMG (run the image build first)" >&2; exit 1; }
TM=$(mktemp -d)
mount -o ro,loop "$IMG" "$TM"
echo "== sha256(payload) =="; sha256sum "$IMG"
echo
echo "== ls -lR \$TM/opt/netbox-agent =="
ls -lR "$TM/opt/netbox-agent"
echo
echo "== required agent files present in built rootfs? =="
rc=0
for f in agent.js provision.js \
         lib/graph.js lib/post_event.js lib/signal_emit.js lib/backup_risk.js \
         lib/enroll.js lib/issue_cert.js lib/tpm.js \
         lib/http_json.js lib/net_checks.js lib/fhir_r4.js lib/mirth_admin.js lib/ehr_check.js; do
  if [ -f "$TM/opt/netbox-agent/$f" ]; then echo "  OK   $f"; else echo "  MISS $f"; rc=1; fi
done
umount "$TM"
[ "$rc" -eq 0 ] && echo "ALL AGENT FILES PRESENT" || { echo "AGENT FILES MISSING" >&2; exit 1; }
