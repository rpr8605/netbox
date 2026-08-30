#!/usr/bin/env bash
# pipeline/stages/00-debootstrap.sh Ã¢â‚¬â€ minimal base system.
set -euo pipefail
TARGET=$1; MIRROR_ARCH=$2
mkdir -p "$TARGET"
debootstrap --arch="$MIRROR_ARCH" --variant=minbase bookworm "$TARGET" \
  http://deb.debian.org/debian
# Boot-critical: keep APT small, no doc/locales in the image.
mkdir -p "$TARGET/etc/apt/apt.conf.d"
cat > "$TARGET/etc/apt/apt.conf.d/99norecommends" <<'EOF'
APT::Install-Recommends "false";
APT::Install-Suggests "false";
EOF
rm -rf "$TARGET/usr/share/doc" "$TARGET/usr/share/locale" "$TARGET/usr/share/man"
