#!/bin/sh
# Removes hlm-agent completely: services, timer, binary, configuration, state and user.
#   curl -fsSL https://raw.githubusercontent.com/midnights-ra1n/homelab-monitoring/stable/rust-agent/uninstall.sh | sudo sh
# smartmontools is left installed (other tools may use it). The host stays listed in the
# dashboard until you delete it there.
set -eu
[ "$(id -u)" -eq 0 ] || { echo "hlm-agent uninstall: must run as root" >&2; exit 1; }
if command -v systemctl >/dev/null 2>&1; then
  systemctl disable --now hlm-agent.service hlm-agent-smart.timer hlm-agent-smart.service hlm-agent-apt.path 2>/dev/null || true
fi
rm -f /etc/systemd/system/hlm-agent.service /etc/systemd/system/hlm-agent-smart.service /etc/systemd/system/hlm-agent-smart.timer \
      /etc/systemd/system/hlm-agent-apt.path /etc/systemd/system/hlm-agent-apt.service
rm -rf /opt/hlm-agent /etc/hlm-agent /usr/local/lib/hlm-agent /var/lib/hlm-agent
command -v systemctl >/dev/null 2>&1 && systemctl daemon-reload
if id hlm-agent >/dev/null 2>&1; then userdel hlm-agent; fi
echo "hlm-agent removed"
