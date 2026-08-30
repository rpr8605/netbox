#!/usr/bin/env bash
# pipeline/stages/30-agent.sh Ã¢â‚¬â€ install the netbox-agent runtime + first-boot
# provisioning into the rootfs. The agent itself is plain JS under
# netbox-agent/ (built repo-side); this stage only stages the files and the
# systemd units that run them. The decrypt unit below carries the user's
# explicitly-requested inline comment about the auto-unlock keyfile tradeoff.
set -euo pipefail
TARGET=$1

# --- runtime placement ------------------------------------------------------
mkdir -p "$TARGET/opt/netbox-agent"
cp -r /work/pipeline/rootfs_files/opt/netbox-agent/* "$TARGET/opt/netbox-agent/"

# --- systemd: LUKS auto-unlock via unencrypted /boot keyfile -----------------
cat > "$TARGET/etc/systemd/system/decrypt-data.service" <<'EOF'
[Unit]
Description=Unlock netbox LUKS data partition using /boot auto-unlock keyfile
DefaultDependencies=no
After=systemd-modules-load.service
Before=local-fs-pre.target shutdown.target
Conflicts=shutdown.target

[Service]
Type=oneshot
# Ã¢â€â‚¬Ã¢â€â‚¬ THREAT-MODEL BOUNDARY (Phase 3 input, decision 2) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
# The keyfile below lives on the small UNencrypted /boot partition. That is a
# deliberate tradeoff, not an oversight:
#   Ã¢â‚¬Â¢ PROTECTS: the threat model from spec Section 2 Ã¢â‚¬â€ a removed/stolen SSD
#     read on another machine. Without this keyfile the drive is ciphertext.
#   Ã¢â‚¬Â¢ DOES NOT PROTECT: an attacker with the WHOLE running appliance, who can
#     boot it (or mount both partitions) and read /boot/netbox.key to unlock
#     the data partition. TPM sealing would resist that; a keyfile cannot.
# The keyfile is generated at first boot and never leaves the device. Not
# network-bound (no Clevis/Tang) so a WAN outage can't block local boot Ã¢â‚¬â€
# downtime-mode availability beats key-sealing strength here.
# If this unit is ever "hardened" by moving the keyfile elsewhere or adding a
# network unlock server, re-read this comment before merging. 
# Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
ExecStart=/bin/sh -c '\
  if [ ! -f /boot/netbox.key ]; then \
    mkdir -p /boot; mount -o rw /dev/disk/by-label/boot /boot; \
    dd if=/dev/urandom of=/boot/netbox.key bs=512 count=1 status=none; \
    chmod 0400 /boot/netbox.key; \
    cryptsetup luksFormat --batch-mode /dev/disk/by-label/DATA /boot/netbox.key; \
    umount /boot; \
  fi; \
  cryptsetup open --key-file /boot/netbox.key /dev/disk/by-label/DATA netbox-data'
RemainAfterExit=yes
EOF
# Key file mode + LuksFormat(andFormat) above must match the agent's keyless
# path expectations exactly; do not soften to passphrase fallback.

# --- systemd: first-boot provisioning -------------------------------------
cat > "$TARGET/etc/systemd/system/netbox-firstboot.service" <<'EOF'
[Unit]
Description=Netbox first-boot provisioning (enroll into quarantine)
After=decrypt-data.service network-online.target
Wants=network-online.target
ConditionPathExists=!/data/enrolled

[Service]
Type=oneshot
ExecStart=/usr/local/bin/node /opt/netbox-agent/provision.js
# Enrollment is one-shot; the renewal loop runs as the agent's daemon unit.
EOF

# --- systemd: ongoing agent (renewal loop + heartbeats) --------------------
cat > "$TARGET/etc/systemd/system/netbox-agent.service" <<'EOF'
[Unit]
Description=Netbox device agent (renewal loop + monitoring orchestrator)
After=netbox-firstboot.service data.mount
RequiresMountsFor=/data

[Service]
Type=simple
ExecStart=/usr/local/bin/node /opt/netbox-agent/agent.js
Restart=always
# Renewal cadence ~50-55% of TTL lives in the agent, not here Ã¢â‚¬â€ a sysadmin
# editing the unit must not be able to widen the expiry silence window.

[Install]
WantedBy=multi-user.target
EOF

# --- binaries the rootfs needs but debootstrap leaves out -----------------
chroot "$TARGET" apt-get update
chroot "$TARGET" apt-get install -y --no-install-recommends \
  systemd-sysv nodejs cryptsetup ca-certificates \
  linux-image-amd64 grub-efi-amd64-bin
# Triggered once: previous builds installed _some_ bundles but never
# /usr/sbin/init, and an unsquashfs probe showed the missing binary. Make
# this an explicit gate so sub-package resolution can't silently slip in.
if ! chroot "$TARGET" test -f /usr/sbin/init; then
  echo "systemd-sysv install did not produce /usr/sbin/init" >&2
  exit 1
fi
cat > "$TARGET/usr/local/bin/node" <<'EOF'
#!/bin/sh
exec /usr/bin/node "$@"
EOF
chmod +x "$TARGET/usr/local/bin/node"

systemd-nspawn --directory="$TARGET" --quiet /bin/systemctl enable \
  decrypt-data.service netbox-firstboot.service netbox-agent.service \
  2>/dev/null || \
chroot "$TARGET" /bin/sh -c \
  'systemctl enable decrypt-data.service netbox-firstboot.service netbox-agent.service'

