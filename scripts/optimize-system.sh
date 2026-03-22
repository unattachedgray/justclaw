#!/bin/bash
# JUSTCLAW System Optimization Script for Lenovo ThinkCentre M725s
# Ubuntu 24.04, AMD Ryzen 5 PRO 2400G, 6.7GB RAM, HDD
#
# Run: sudo bash scripts/optimize-system.sh
#
# What it does:
#   1. Kernel tuning (swappiness, inotify, dirty pages)
#   2. Filesystem optimization (noatime, commit interval)
#   3. Disable unnecessary services (apache, mysql, cups, etc.)
#   4. Journal log cleanup and cap
#   5. Install zram (compressed RAM swap)
#   6. Install mosh (better SSH)
#   7. Clean old snap revisions
#   8. Report results

set -e

if [ "$EUID" -ne 0 ]; then
  echo "Run with sudo: sudo bash $0"
  exit 1
fi

echo "========================================="
echo "JUSTCLAW System Optimization"
echo "========================================="
echo ""

# --- 1. Kernel tuning ---
echo "[1/8] Kernel tuning..."
cat > /etc/sysctl.d/99-dev-tuning.conf << 'EOF'
# JUSTCLAW dev tuning — optimized for Node.js on 6.7GB RAM + HDD
vm.swappiness=10
fs.inotify.max_user_watches=524288
vm.dirty_ratio=10
vm.dirty_background_ratio=5
EOF
sysctl -p /etc/sysctl.d/99-dev-tuning.conf
echo "  ✅ swappiness=10, inotify=524288, dirty pages tuned"

# --- 2. Filesystem optimization ---
echo "[2/8] Filesystem optimization..."
if grep -q 'noatime' /etc/fstab; then
  echo "  ⏭️  noatime already set"
else
  # Only modify the ext4 root partition line
  sed -i '/ext4.*errors=remount-ro/ s/errors=remount-ro/noatime,commit=30,errors=remount-ro/' /etc/fstab
  mount -o remount / 2>/dev/null || echo "  ⚠️  Remount failed — will take effect on next boot"
  echo "  ✅ noatime + commit=30 set (reduces HDD writes)"
fi

# --- 3. Disable unnecessary services ---
echo "[3/8] Disabling unnecessary services..."
SERVICES="apache2 mysql ModemManager cups cups-browsed avahi-daemon colord kerneloops fwupd gnome-remote-desktop"
for svc in $SERVICES; do
  if systemctl is-active --quiet "$svc" 2>/dev/null; then
    systemctl stop "$svc" 2>/dev/null
    systemctl disable "$svc" 2>/dev/null
    echo "  ✅ Stopped and disabled: $svc"
  elif systemctl is-enabled --quiet "$svc" 2>/dev/null; then
    systemctl disable "$svc" 2>/dev/null
    echo "  ✅ Disabled: $svc"
  else
    echo "  ⏭️  Already off: $svc"
  fi
done

# Also try snap services
for svc in snap.cups.cupsd snap.cups.cups-browsed; do
  systemctl stop "$svc" 2>/dev/null && systemctl disable "$svc" 2>/dev/null && echo "  ✅ Disabled snap: $svc" || true
done

# --- 4. Journal cleanup ---
echo "[4/8] Journal log cleanup..."
BEFORE=$(journalctl --disk-usage 2>/dev/null | grep -oP '[\d.]+[MG]' || echo "unknown")
journalctl --vacuum-size=100M 2>/dev/null
mkdir -p /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/size.conf << 'EOF'
[Journal]
SystemMaxUse=100M
EOF
systemctl restart systemd-journald
AFTER=$(journalctl --disk-usage 2>/dev/null | grep -oP '[\d.]+[MG]' || echo "unknown")
echo "  ✅ Journal: $BEFORE → $AFTER (capped at 100M)"

# --- 5. Install zram ---
echo "[5/8] Installing zram (compressed RAM swap)..."
if command -v zramctl &>/dev/null && zramctl | grep -q zram; then
  echo "  ⏭️  zram already active"
else
  apt-get install -y -qq zram-tools 2>/dev/null
  cat > /etc/default/zramswap << 'EOF'
ALGO=zstd
PERCENT=50
PRIORITY=100
EOF
  systemctl enable --now zramswap 2>/dev/null
  echo "  ✅ zram installed (50% of RAM = ~3.3GB compressed swap)"
fi

# --- 6. Install mosh ---
echo "[6/8] Installing mosh..."
if command -v mosh &>/dev/null; then
  echo "  ⏭️  mosh already installed"
else
  apt-get install -y -qq mosh 2>/dev/null
  # Open UDP ports for mosh in UFW if active
  if ufw status 2>/dev/null | grep -q active; then
    ufw allow 60000:61000/udp 2>/dev/null
    echo "  ✅ mosh installed + firewall opened"
  else
    echo "  ✅ mosh installed"
  fi
fi

# --- 7. Clean old snap revisions ---
echo "[7/8] Cleaning old snap revisions..."
snap set system refresh.retain=2 2>/dev/null || true
CLEANED=0
snap list --all 2>/dev/null | awk '/disabled/{print $1, $3}' | while read snapname revision; do
  snap remove "$snapname" --revision="$revision" 2>/dev/null && CLEANED=$((CLEANED+1))
done
echo "  ✅ Snap retention set to 2 revisions"

# --- 8. Report ---
echo ""
echo "========================================="
echo "Results"
echo "========================================="
echo ""
free -h
echo ""
echo "Kernel params:"
sysctl vm.swappiness fs.inotify.max_user_watches vm.dirty_ratio vm.dirty_background_ratio
echo ""
echo "Active swap devices:"
cat /proc/swaps
echo ""
echo "Mount options (root):"
mount | grep ' / '
echo ""
echo "Services stopped:"
for svc in $SERVICES; do
  systemctl is-active --quiet "$svc" 2>/dev/null && echo "  ⚠️  Still running: $svc" || echo "  ✅ Off: $svc"
done
echo ""
echo "========================================="
echo "Done! Estimated improvements:"
echo "  • ~400MB RAM freed (mysql, apache, cups, etc.)"
echo "  • ~3GB effective RAM from zram compression"
echo "  • Reduced HDD writes (noatime, commit=30)"
echo "  • 524K inotify watches (was 65K)"
echo "  • Swappiness 10 (was 60) — avoids HDD swap thrashing"
echo "  • mosh available for SSH (survives disconnects)"
echo ""
echo "Hardware upgrade recommendations (ThinkCentre M725s):"
echo "  • RAM: Add 8GB DDR4-2666 SO-DIMM (~\$15) → 16GB dual-channel"
echo "    - Crucial CT8G4SFS8266 or Kingston KVR26S19S8/8"
echo "  • SSD: Add M.2 2280 SATA 250GB (~\$25) or replace HDD with 2.5\" SATA SSD"
echo "    - WD Blue SA510 M.2 250GB or Samsung 870 EVO 500GB (\$40)"
echo "    - Need 2.5→3.5\" bracket if replacing HDD"
echo "  • Total: ~\$40-70 for a transformative upgrade"
echo "========================================="
