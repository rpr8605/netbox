#!/usr/bin/env bash
# pipeline/stages/20-partition.sh — partition-map validation stage.
# Previously emitted /tmp/partition.env for 40-rauc.sh, but that file was never
# actually consumed (40-rauc.sh reads the same JSON map directly). Kept as a
# named stage hook so the executor ordering stays stable; the partition map is
# the single source of truth in pipeline/manifests/beacon-relay-partition-map.json.
set -euo pipefail
TARGET=$1
MAP=/work/pipeline/manifests/beacon-relay-partition-map.json
# Validate the map is readable JSON; downstream stages depend on it.
jq -e '.partitions' "$MAP" >/dev/null
echo "partition map validated"


