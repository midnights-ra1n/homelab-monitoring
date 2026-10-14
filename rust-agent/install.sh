#!/bin/sh
# Installs or upgrades hlm-agent on Debian. Idempotent and non-interactive, so it can be
# run as-is by Ansible. Configuration comes from the environment:
#   HUB_URL, TOKEN, KEY   required on first install (kept from /etc/hlm-agent/agent.env otherwise)
#   ALLOW_INSECURE=true   accept a plain http:// hub
#   AUTO_UPDATE=false     disable the daily self-update
#   SMART=false           skip SMART collection (smartmontools + hourly root timer)
#   REMOTE_UPDATES=false  forbid "check / install updates" buttons of the dashboard
#   VERSION=v0.1.12       pin a release (default: latest)
#   REPO=owner/name       GitHub repository hosting the releases
# Uninstall: curl -fsSL https://raw.githubusercontent.com/midnights-ra1n/homelab-monitoring/stable/rust-agent/uninstall.sh | sudo sh
set -eu

REPO="${REPO:-midnights-ra1n/homelab-monitoring}"
PREFIX=/opt/hlm-agent
CONF_DIR=/etc/hlm-agent
CONF="$CONF_DIR/agent.env"
UNIT=/etc/systemd/system/hlm-agent.service
SYSTEMD=/etc/systemd/system
LIBEXEC=/usr/local/lib/hlm-agent
STATE=/var/lib/hlm-agent

die() { echo "hlm-agent install: $*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || die "must run as root"
command -v systemctl >/dev/null || die "systemd is required"

if [ "${1:-}" = "--uninstall" ]; then
  # Kept for compatibility; uninstall.sh is the documented way.
  fetch() { curl -fsSL --proto '=https' "$1" 2>/dev/null || wget -qO- --https-only "$1"; }
  fetch "https://raw.githubusercontent.com/$REPO/stable/rust-agent/uninstall.sh" | sh
  exit 0
fi

case "$(uname -m)" in
  x86_64|amd64) ARCH=x86_64 ;;
  aarch64|arm64) ARCH=aarch64 ;;
  *) die "unsupported architecture $(uname -m)" ;;
esac

if [ -n "${VERSION:-}" ]; then BASE="https://github.com/$REPO/releases/download/$VERSION"
else BASE="https://github.com/$REPO/releases/latest/download"; fi
ASSET="hlm-agent-linux-$ARCH"

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
fetch() {
  if command -v curl >/dev/null; then curl -fsSL --proto '=https' --tlsv1.2 -o "$2" "$1"
  elif command -v wget >/dev/null; then wget -q --https-only -O "$2" "$1"
  else die "curl or wget is required"; fi
}
fetch "$BASE/$ASSET" "$TMP/hlm-agent"
fetch "$BASE/$ASSET.sha256" "$TMP/sum"
( cd "$TMP" && echo "$(cut -d' ' -f1 sum)  hlm-agent" | sha256sum -c - >/dev/null ) || die "checksum mismatch"

id hlm-agent >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin hlm-agent
install -d -o hlm-agent -g hlm-agent -m 0755 "$PREFIX"
install -o hlm-agent -g hlm-agent -m 0755 "$TMP/hlm-agent" "$PREFIX/hlm-agent"

install -d -m 0750 -g hlm-agent "$CONF_DIR"
if [ -n "${TOKEN:-}" ] || [ ! -f "$CONF" ]; then
  [ -n "${HUB_URL:-}" ] && [ -n "${TOKEN:-}" ] && [ -n "${KEY:-}" ] || die "HUB_URL, TOKEN and KEY are required"
  umask 027
  {
    echo "HUB_URL=$HUB_URL"
    echo "TOKEN=$TOKEN"
    echo "KEY=$KEY"
    [ -n "${ALLOW_INSECURE:-}" ] && echo "ALLOW_INSECURE=$ALLOW_INSECURE"
    [ -n "${AUTO_UPDATE:-}" ] && echo "AUTO_UPDATE=$AUTO_UPDATE"
    [ "$REPO" != "midnights-ra1n/homelab-monitoring" ] && echo "UPDATE_REPO=$REPO"
    true
  } > "$CONF.tmp"
  chown root:hlm-agent "$CONF.tmp"; chmod 0640 "$CONF.tmp"; mv "$CONF.tmp" "$CONF"
fi

RAW="https://raw.githubusercontent.com/$REPO/${VERSION:-stable}/rust-agent"
for f in hlm-agent.service hlm-agent-smart.service hlm-agent-smart.timer smart-collect.sh \
         hlm-agent-apt.path hlm-agent-apt.service apt-action.sh; do
  fetch "$RAW/$f" "$TMP/$f"
done
install -m 0644 "$TMP/hlm-agent.service" "$UNIT"

# SMART: a root-owned script (never the self-updating agent binary) runs smartctl hourly.
install -d -o root -g hlm-agent -m 0750 "$STATE"
if [ "${SMART:-true}" != "false" ]; then
  if ! command -v smartctl >/dev/null 2>&1 && command -v apt-get >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq smartmontools >/dev/null || echo "hlm-agent install: smartmontools not installed, SMART disabled" >&2
  fi
  install -d -o root -g root -m 0755 "$LIBEXEC"
  install -o root -g root -m 0755 "$TMP/smart-collect.sh" "$LIBEXEC/smart-collect.sh"
  install -m 0644 "$TMP/hlm-agent-smart.service" "$SYSTEMD/hlm-agent-smart.service"
  install -m 0644 "$TMP/hlm-agent-smart.timer" "$SYSTEMD/hlm-agent-smart.timer"
fi

# Dashboard apt actions: root-owned helper started by a path unit, fixed actions only.
install -d -o root -g root -m 0755 "$LIBEXEC"
if [ "${REMOTE_UPDATES:-true}" != "false" ]; then
  install -o root -g root -m 0755 "$TMP/apt-action.sh" "$LIBEXEC/apt-action.sh"
  install -m 0644 "$TMP/hlm-agent-apt.path" "$SYSTEMD/hlm-agent-apt.path"
  install -m 0644 "$TMP/hlm-agent-apt.service" "$SYSTEMD/hlm-agent-apt.service"
else
  systemctl disable --now hlm-agent-apt.path 2>/dev/null || true
  rm -f "$LIBEXEC/apt-action.sh" "$SYSTEMD/hlm-agent-apt.path" "$SYSTEMD/hlm-agent-apt.service"
fi

systemctl daemon-reload
systemctl enable hlm-agent >/dev/null 2>&1
[ "${REMOTE_UPDATES:-true}" != "false" ] && systemctl enable --now hlm-agent-apt.path >/dev/null 2>&1
if [ "${SMART:-true}" != "false" ]; then
  systemctl enable --now hlm-agent-smart.timer >/dev/null 2>&1
  systemctl start hlm-agent-smart.service || true
fi
systemctl restart hlm-agent
echo "hlm-agent $("$PREFIX/hlm-agent" --version) installed and running"
