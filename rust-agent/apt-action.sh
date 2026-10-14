#!/bin/sh
# apt actions requested from the Homelab Monitoring dashboard, run as root by
# hlm-agent-apt.path when the agent drops a request file. Root-owned on purpose, and it
# accepts exactly two words from the unprivileged agent: "refresh" (apt-get update) and
# "upgrade" (apt-get update + upgrade). Disable with REMOTE_UPDATES=false at install time.
set -u
REQ=/var/lib/hlm-agent/state/apt-request
OUT=/var/lib/hlm-agent/apt
[ -f "$REQ" ] && [ ! -L "$REQ" ] || { rm -f "$REQ"; exit 0; }
action=$(head -c 16 "$REQ" | tr -dc 'a-z')
rm -f "$REQ"
case "$action" in refresh|upgrade) ;; *) exit 0 ;; esac

install -d -o root -g hlm-agent -m 0750 "$OUT"
status() {
  printf '{"action":"%s","state":"%s","exit_code":%s,"finished_at":%s}\n' "$action" "$1" "$2" "$(date +%s)" > "$OUT/status.tmp"
  chgrp hlm-agent "$OUT/status.tmp"; chmod 0640 "$OUT/status.tmp"; mv "$OUT/status.tmp" "$OUT/status.json"
}
status running null
: > "$OUT/log"; chgrp hlm-agent "$OUT/log"; chmod 0640 "$OUT/log"

export DEBIAN_FRONTEND=noninteractive LC_ALL=C
apt-get update -q >> "$OUT/log" 2>&1
rc=$?
if [ "$rc" -eq 0 ] && [ "$action" = upgrade ]; then
  # Keep local configuration files; never remove packages (no dist-upgrade).
  apt-get -y -q -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold --with-new-pkgs upgrade >> "$OUT/log" 2>&1
  rc=$?
fi
if [ "$rc" -eq 0 ]; then status done 0; else status failed "$rc"; fi
