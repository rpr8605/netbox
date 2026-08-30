#!/usr/bin/env bash
# pipeline/stages/20-partition.sh Ã¢â‚¬â€ read the declarative partition map and emit
# /tmp/partition.env (LABEL -> index assignments) consumed by 40-rauc.sh when it
# writes the on-image /etc/rauc/system.conf. Staying declarative here is what
# keeps the RAUC slot labels and the actual GPT labels from drifting apart.
set -euo pipefail
TARGET=$1
MAP=/work/pipeline/manifests/netbox-partition-map.json
jq -r '.partitions | to_entries[] | "PART_\(.key+1)_\(.value.role | gsub("[^A-Za-z0-9]";"_") | ascii_upcase)=\(.value.label)"' \
  "$MAP" > /tmp/partition.env
echo "partition map staged:"
cat /tmp/partition.env

