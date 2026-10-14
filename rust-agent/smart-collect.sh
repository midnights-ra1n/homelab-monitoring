#!/bin/sh
# SMART collection for hlm-agent, run as root by hlm-agent-smart.timer (no network).
# Root-owned on purpose: it must never be something the unprivileged agent can rewrite.
# Writes one smartctl JSON file per disk; the agent reads them from /var/lib/hlm-agent/smart.
set -eu
OUT=/var/lib/hlm-agent/smart
rm -rf "$OUT.new"
mkdir -m 0750 "$OUT.new"
if ! command -v smartctl >/dev/null 2>&1; then
  : > "$OUT.new/ERROR"
else
  i=0
  # Lines look like: /dev/sda -d sat # /dev/sda [SAT], ATA device
  smartctl --scan-open | while read -r dev flag type _; do
    case "$dev" in /dev/*) ;; *) continue ;; esac
    [ "$flag" = "-d" ] || type=auto
    i=$((i + 1))
    # smartctl's exit status is a bitmask, non-zero even for readable disks.
    smartctl -a -j -d "$type" "$dev" > "$OUT.new/$i.json" 2>/dev/null || true
  done
fi
chgrp -R hlm-agent "$OUT.new"
chmod 0640 "$OUT.new"/* 2>/dev/null || true
rm -rf "$OUT.old"
[ -d "$OUT" ] && mv "$OUT" "$OUT.old"
mv "$OUT.new" "$OUT"
rm -rf "$OUT.old"
