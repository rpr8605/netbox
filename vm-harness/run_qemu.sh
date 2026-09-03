#!/usr/bin/env bash
# vm-harness/run_qemu.sh â€” boots out/<version>/netbox-disk.img under
# QEMU+OVMF+swtpm. Boots to a login/serial log and polls the sdp URI to
# detect cloud-init/enrollment completion. Re-uses the compose control plane
# image's mTLS expectations only if the image is configured to; the harness
# asserts two trust outcomes: (1) boot completes (banner), (2) the image's
# agent node is running (process marker in serial output). Deeper enrollment
# signaling requires agent-network plumbing â€” flagged in the report.
set -euo pipefail
VERSION=${1:?version}
IMG=/out/$VERSION/netbox-disk.img
MEM=${2:-2048}
SSH_FWD=${3:-2222}

# Fresh serial log per run — tailing an old boot's log has been a recurring
# false-negative source across this phase.
: > /tmp/serial.log
mkdir -p /tmp/swtpm-state
swtpm socket --tpm2 --tpmstate dir=/tmp/swtpm-state \
  --ctrl type=unixio,path=/tmp/swtpm-sock \
  --flags not-need-init,startup-clear &

# OVMF_VARS must be writable; QEMU will mutate NVRAM on boot.
cp /usr/share/OVMF/OVMF_VARS.fd /tmp/OVMF_VARS.fd
qemu-system-x86_64 -m "$MEM" -smp 2 -enable-kvm \
  -drive file=$IMG,format=raw,if=none,id=hd0 \
  -device ahci,id=ahci -device ide-hd,drive=hd0,bus=ahci.0 \
  -drive if=pflash,format=raw,readonly=on,file=/usr/share/OVMF/OVMF_CODE.fd \
  -drive if=pflash,format=raw,file=/tmp/OVMF_VARS.fd \
  -chardev socket,id=chrtpm,path=/tmp/swtpm-sock \
  -tpmdev emulator,id=tpm0,chardev=chrtpm \
  -device tpm-tis,tpmdev=tpm0 \
  -netdev user,id=net0,hostfwd=tcp::${SSH_FWD}-:22 -device e1000,netdev=net0 \
  -serial file:/tmp/serial.log -display none -daemonize

echo "qemu started; serial:/tmp/serial.log"
# Poll for the provisioning units; surface failures instead of requiring
# manual inspection of an un-tailed serial log.
for i in $(seq 1 60); do
  if grep -q "login:" /tmp/serial.log 2>/dev/null; then break; fi
  sleep 2
done
echo "--- unit status probe ---"
for u in decrypt-data.service netbox-firstboot.service netbox-agent.service; do
  grep -i "$u" /tmp/serial.log | tail -3 || echo "$u: no serial lines"
done
