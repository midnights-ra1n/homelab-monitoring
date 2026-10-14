#!/bin/sh
# Removes hlm-agent completely: services, timers, binary, configuration, state and user.
#   curl -fsSL https://raw.githubusercontent.com/midnights-ra1n/homelab-monitoring/stable/rust-agent/uninstall.sh | sudo sh
# On a Proxmox host, add LXC=all to remove it from every running LXC container too:
#   curl -fsSL …/uninstall.sh | sudo LXC=all sh
# smartmontools is left installed (other tools may use it). The hosts stay listed in the
# dashboard until you delete them there.
set -eu
[ "$(id -u)" -eq 0 ] || { echo "hlm-agent uninstall: must run as root" >&2; exit 1; }

# Kept in a variable so the same steps can be piped into each LXC container.
REMOVE=$(cat <<'EOS'
units="hlm-agent.service hlm-agent-smart.timer hlm-agent-smart.service hlm-agent-apt.path hlm-agent-apt.service
       hlm-agent-docker.timer hlm-agent-docker.service hlm-agent-docker-update.path hlm-agent-docker-update.service"
if command -v systemctl >/dev/null 2>&1; then
  for u in $units; do systemctl disable --now "$u" 2>/dev/null || true; done
fi
for u in $units; do rm -f "/etc/systemd/system/$u"; done
rm -rf /etc/systemd/system/hlm-agent.service.d /opt/hlm-agent /etc/hlm-agent /usr/local/lib/hlm-agent /var/lib/hlm-agent
command -v systemctl >/dev/null 2>&1 && systemctl daemon-reload
if id hlm-agent >/dev/null 2>&1; then userdel hlm-agent; fi
echo "hlm-agent removed from $(hostname)"
EOS
)

sh -c "$REMOVE"

if [ "${LXC:-}" = all ] && command -v pct >/dev/null 2>&1; then
  for ct in $(pct list | awk 'NR > 1 && $2 == "running" { print $1 }'); do
    if pct exec "$ct" -- test -d /opt/hlm-agent 2>/dev/null; then
      printf '%s\n' "$REMOVE" | pct exec "$ct" -- sh -s || echo "  CT $ct: removal failed"
    fi
  done
fi
