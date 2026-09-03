#!/usr/bin/env bash
# pipeline/stages/10-configure.sh Ã¢â‚¬â€ fstab + minimal net + hostname.
set -euo pipefail
TARGET=$1
cat > "$TARGET/etc/fstab" <<'EOF'
# Root (read-only by remount)
/dev/sda3  /       ext4  ro,errors=remount-ro     0 1
# Unencrypted auto-unlock keyfile. See the decrypt-data.service (staged by
# 30-agent.sh) for the explicit tradeoff comment — protects a stolen drive read
# elsewhere, not a running appliance kept in an attacker's hands.
/dev/sda2  /boot   ext2  ro,noauto                0 2
# NOTE: /data is NOT in fstab on purpose — decrypt-data.service opens the LUKS
# container and mounts it itself (and mkfs's it on first boot). A fstab entry
# would race the LUKS open via data.mount and double-mount.
EOF
echo netbox > "$TARGET/etc/hostname"

# Root mounts read-only (fstab: /dev/sda3 ro), so any mountpoint the system
# needs at runtime must exist in the image NOW — you cannot mkdir on a ro root
# at boot. /data is the LUKS partition's mountpoint (mounted by
# decrypt-data.service); /boot is the keyfile partition's mountpoint.
mkdir -p "$TARGET/data" "$TARGET/boot"
# DHCP-first; persists at boot-time to the wire-or-nothing posture.
mkdir -p "$TARGET/etc/systemd/network"
cat > "$TARGET/etc/systemd/network/20-wired.network" <<'EOF'
[Match]
Name=en*

[Network]
DHCP=yes
EOF

# First-boot config: baked into the rootfs at /etc/netbox.env (NOT /boot —
# /boot is the unencrypted keyfile partition and would shadow the rootfs copy).
mkdir -p "$TARGET/etc"
{
  echo "CONTROL_PLANE_URL=${CONTROL_PLANE_URL:-https://10.0.2.2:9100}"
  echo "CA_URL=${CA_URL:-https://10.0.2.2:9000}"
} > "$TARGET/etc/netbox.env"
