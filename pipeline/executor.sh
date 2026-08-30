#!/usr/bin/env bash
# pipeline/executor.sh Ã¢â‚¬â€ runs the ordered stage scripts to produce rootfs.ext4.
# Invoked by pipeline/build.sh inside the worker container. Stage contract:
# every stages/*.sh must be idempotent and operate strictly under $TARGET as
# root. No stage may network beyond the debootstrap mirror and HTTPS CA root fetch.
set -euo pipefail
TARGET=${1:?usage: TARGET MIRROR_ARCH}
MIRROR_ARCH=${2:-amd64}
export DEBIAN_FRONTEND=noninteractive

DIR=$(dirname "$0")

run_stage() {
  echo "=== stage: $1 ==="
  bash "$1" "$TARGET" "$MIRROR_ARCH"
}

run_stage "$DIR/stages/00-debootstrap.sh"
run_stage "$DIR/stages/10-configure.sh"
run_stage "$DIR/stages/20-partition.sh"
run_stage "$DIR/stages/30-agent.sh"
run_stage "$DIR/stages/40-rauc.sh"
