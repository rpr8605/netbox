#!/usr/bin/env bash
# vm-harness/probe_parted.sh — parted printout of the built image. Used to
# confirm GPT data like ESP flags and filesystem types on the QEMU/OVMF path.
set -euo pipefail
VERSION=${1:?version}
cp "/out/$VERSION/netbox-disk.img" /tmp/probe.img
parted -s /tmp/probe.img print free
