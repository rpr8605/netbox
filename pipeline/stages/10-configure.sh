#!/usr/bin/env bash
# pipeline/stages/10-configure.sh Ã¢â‚¬â€ fstab + minimal net + hostname.
set -euo pipefail
TARGET=$1
cat > "$TARGET/etc/fstab" <<'EOF'
# Root (read-only by remount)
/dev/disk/by-label/ROOTFS_A /       ext4  ro,errors=remount-ro     0 1
# Unencrypted auto-unlock keyfile. See the decrypt-data.service (staged by
# 30-agent.sh) for the explicit tradeoff comment — protects a stolen drive read
# elsewhere, not a running appliance kept in an attacker's hands.
/dev/disk/by-label/BOOT     /boot   ext2  ro,noauto                0 2
/dev/mapper/netbox-data     /data   ext4  nofail                   0 2
EOF
echo netbox > "$TARGET/etc/hostname"
# DHCP-first; persists at boot-time to the wire-or-nothing posture.
mkdir -p "$TARGET/etc/systemd/network"
cat > "$TARGET/etc/systemd/network/20-wired.network" <<'EOF'
[Match]
Name=en*

[Network]
DHCP=yes
EOF
