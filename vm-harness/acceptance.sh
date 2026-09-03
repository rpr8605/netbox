#!/usr/bin/env bash
# vm-harness/acceptance.sh — the Phase 3 acceptance run, end to end:
#   1. copy the built disk image (never boot the artifact itself)
#   2. mint a one-time enrollment token from the REAL control plane
#   3. write it onto the BOOT partition of the copy
#   4. boot under QEMU+OVMF+swtpm and wait for provisioning to reach quarantine
#   5. confirm the device out of quarantine via the CP operator endpoint
#   6. assert the agent daemon's next heartbeat shows state=active
# Prints ACCEPTANCE_PASS/FAIL lines; exit code matches.
set -euo pipefail
VERSION=${1:-0.1.0}
MEM=${2:-1024}
CP=${CONTROL_PLANE_URL:-https://control-plane:9100}
SRC=/out/$VERSION/netbox-disk.img
IMG=/tmp/acceptance-disk.raw
SERIAL=/tmp/serial.log
DEVICE_ID=$(cat /proc/sys/kernel/random/uuid)
SITE_ID=$(cat /proc/sys/kernel/random/uuid)

log() { echo "acceptance: $*"; }
fail() { echo "ACCEPTANCE_FAIL: $*"; exit 1; }

# --- 1. working copy ---------------------------------------------------------
cp "$SRC" "$IMG"
: > "$SERIAL"

# --- 2. mint token from the real control plane -------------------------------
log "minting enrollment token (device=$DEVICE_ID)"
TOKEN_JSON=$(curl -sk -X POST "$CP/api/enroll/tokens" \
  -H 'content-type: application/json' \
  -d "{\"device_id\":\"$DEVICE_ID\",\"site_id\":\"$SITE_ID\"}")
TOKEN=$(echo "$TOKEN_JSON" | jq -r '.enrollment_token')
[ "$TOKEN" = "null" ] && fail "token mint failed: $TOKEN_JSON"

# --- 3. inject token onto BOOT partition of the copy -------------------------
LOOP=""
losetup -D >/dev/null 2>&1 || true
for n in $(seq 0 255); do
  DEV=/dev/loop$n
  [ -b "$DEV" ] || mknod -b 7 "$n" "$DEV" || true
  if losetup "$DEV" "$IMG" 2>/dev/null; then LOOP=$DEV; break; fi
done
[ -z "$LOOP" ] && fail "no free loop device"
kpartx -av "$LOOP" >/dev/null
BASE=/dev/mapper/$(basename "$LOOP")
TM=$(mktemp -d)
mount "${BASE}p2" "$TM"
printf '%s' "$TOKEN" > "$TM/enrollment.token"
umount "$TM"
kpartx -dv "$LOOP" >/dev/null 2>&1 || true
losetup -d "$LOOP"
log "token injected onto BOOT partition"

# --- 3b. bridge the QEMU guest to the real control plane ----------------------
# QEMU user-mode networking (SLIRP) maps the guest's 10.0.2.2 to the HOST
# namespace — i.e. THIS harness container, not the docker network. The image's
# baked config points at 10.0.2.2:9100/9000, so we relay those ports here to
# the real control-plane / step-ca containers. This is the "agent-network
# plumbing" run_qemu.sh's header flagged as missing.
socat TCP-LISTEN:9100,fork,reuseaddr TCP:control-plane:9100 &
socat TCP-LISTEN:9000,fork,reuseaddr TCP:step-ca:9000 &
log "socat relays up: guest 10.0.2.2:9100->control-plane, :9000->step-ca"

# --- 4. boot -----------------------------------------------------------------
mkdir -p /tmp/swtpm-state
swtpm socket --tpm2 --tpmstate dir=/tmp/swtpm-state \
  --ctrl type=unixio,path=/tmp/swtpm-sock \
  --flags not-need-init,startup-clear &
cp /usr/share/OVMF/OVMF_VARS.fd /tmp/OVMF_VARS.fd
qemu-system-x86_64 -m "$MEM" -smp 2 -enable-kvm \
  -drive file=$IMG,format=raw,if=none,id=hd0 \
  -device ahci,id=ahci -device ide-hd,drive=hd0,bus=ahci.0 \
  -drive if=pflash,format=raw,readonly=on,file=/usr/share/OVMF/OVMF_CODE.fd \
  -drive if=pflash,format=raw,file=/tmp/OVMF_VARS.fd \
  -chardev socket,id=chrtpm,path=/tmp/swtpm-sock \
  -tpmdev emulator,id=tpm0,chardev=chrtpm \
  -device tpm-tis,tpmdev=tpm0 \
  -netdev user,id=net0 -device e1000,netdev=net0 \
  -serial file:$SERIAL -display none -daemonize
log "qemu started; waiting for provisioning"

for i in $(seq 1 90); do
  if grep -q "enrolled and quarantined" "$SERIAL" 2>/dev/null; then break; fi
  if grep -q "FAILED" "$SERIAL" 2>/dev/null; then break; fi
  sleep 2
done

tr '\r' '\n' < "$SERIAL" | grep -E "provision:|decrypt:" | tail -15

grep -q "long-term key sealed via TPM" "$SERIAL" || fail "TPM branch not taken"
log "TPM sealing branch confirmed (swtpm)"
grep -q "enrolled and quarantined" "$SERIAL" || fail "provisioning did not reach quarantine"
log "quarantine entered against the real control plane"

# --- 5. confirm out of quarantine --------------------------------------------
CONF=$(curl -sk -X POST "$CP/api/devices/$DEVICE_ID/confirm")
log "confirm response: $CONF"
echo "$CONF" | jq -e '.state=="active"' >/dev/null || fail "confirm did not activate device"

# --- 6. agent daemon heartbeat as active -------------------------------------
sleep 15
# `|| true` on the greps: an empty match is a DATA point asserted below, not a
# script-killing pipefail exit that swallows the fail() message.
tr '\r' '\n' < "$SERIAL" | grep -E "agent:" | tail -5 || true
grep -q "state=active" "$SERIAL" || fail "agent heartbeat did not show active"
grep -q "daemon running" "$SERIAL" || fail "agent daemon not running"

echo "ACCEPTANCE_PASS: provision(TPM-seal) -> quarantine -> confirm -> active heartbeat"
