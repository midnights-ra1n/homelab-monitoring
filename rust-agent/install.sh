#!/bin/sh
# Installs or upgrades hlm-agent on Debian. Idempotent and non-interactive, so it can be
# run as-is by Ansible. Configuration comes from the environment:
#   HUB_URL, TOKEN, KEY   required on first install (kept from /etc/hlm-agent/agent.env otherwise)
#   ALLOW_INSECURE=true   accept a plain http:// hub
#   AUTO_UPDATE=false     disable the daily self-update
#   SMART=false           skip SMART collection (smartmontools + hourly root timer)
#   REMOTE_UPDATES=false  forbid the "check / install updates" buttons of the dashboard
#   DOCKER=false|true     Docker monitoring (default: enabled when docker is installed)
#   LXC=all               on a Proxmox host, also install in every running Debian LXC container,
#                         with the shared enrollment token LXC_TOKEN (enr_…, defaults to TOKEN)
#   VERSION=v0.1.12       pin a release (default: latest)
#   REPO=owner/name       GitHub repository hosting the releases
# Uninstall: curl -fsSL https://raw.githubusercontent.com/midnights-ra1n/homelab-monitoring/stable/rust-agent/uninstall.sh | sudo sh
set -eu

REPO="${REPO:-midnights-ra1n/homelab-monitoring}"
PREFIX=/opt/hlm-agent
CONF_DIR=/etc/hlm-agent
CONF="$CONF_DIR/agent.env"
SYSTEMD=/etc/systemd/system
LIBEXEC=/usr/local/lib/hlm-agent
STATE=/var/lib/hlm-agent
FILES="install.sh hlm-agent.service hlm-agent-smart.service hlm-agent-smart.timer smart-collect.sh
       hlm-agent-apt.path hlm-agent-apt.service apt-action.sh
       hlm-agent-docker.service hlm-agent-docker.timer hlm-agent-docker-update.path
       hlm-agent-docker-update.service docker-helper.sh"

die() { echo "hlm-agent install: $*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || die "must run as root"
command -v systemctl >/dev/null || die "systemd is required"

if [ "${1:-}" = "--uninstall" ]; then
  # Kept for compatibility; uninstall.sh is the documented way.
  { curl -fsSL --proto '=https' "https://raw.githubusercontent.com/$REPO/stable/rust-agent/uninstall.sh" 2>/dev/null \
    || wget -qO- --https-only "https://raw.githubusercontent.com/$REPO/stable/rust-agent/uninstall.sh"; } | sh
  exit 0
fi

case "$(uname -m)" in
  x86_64|amd64) ARCH=x86_64 ;;
  aarch64|arm64) ARCH=aarch64 ;;
  *) die "unsupported architecture $(uname -m)" ;;
esac

if [ -n "${BUNDLE:-}" ]; then
  # Files already downloaded and verified by a Proxmox host (LXC=all): no network needed.
  TMP=$BUNDLE
  [ -f "$TMP/hlm-agent" ] && [ -f "$TMP/sum" ] || die "incomplete bundle $BUNDLE"
else
  if [ -n "${VERSION:-}" ]; then BASE="https://github.com/$REPO/releases/download/$VERSION"
  else BASE="https://github.com/$REPO/releases/latest/download"; fi
  TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
  fetch() {
    if command -v curl >/dev/null; then curl -fsSL --proto '=https' --tlsv1.2 -o "$2" "$1"
    elif command -v wget >/dev/null; then wget -q --https-only -O "$2" "$1"
    else die "curl or wget is required"; fi
  }
  fetch "$BASE/hlm-agent-linux-$ARCH" "$TMP/hlm-agent"
  fetch "$BASE/hlm-agent-linux-$ARCH.sha256" "$TMP/sum"
  RAW="https://raw.githubusercontent.com/$REPO/${VERSION:-stable}/rust-agent"
  for f in $FILES; do fetch "$RAW/$f" "$TMP/$f"; done
fi
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

install -m 0644 "$TMP/hlm-agent.service" "$SYSTEMD/hlm-agent.service"
install -d -o root -g hlm-agent -m 0750 "$STATE"
install -d -o root -g root -m 0755 "$LIBEXEC"

# Optional root helpers. Each is a root-owned script with a fixed job, never the agent binary
# (which the agent can rewrite to update itself). $1 = enabled, $2 = units to enable, rest = files.
helper() {
  enabled=$1; units=$2; shift 2
  if [ "$enabled" = true ]; then
    for f in "$@"; do
      case "$f" in
        *.sh) install -o root -g root -m 0755 "$TMP/$f" "$LIBEXEC/$f" ;;
        *) install -m 0644 "$TMP/$f" "$SYSTEMD/$f" ;;
      esac
    done
    systemctl daemon-reload
    for u in $units; do systemctl enable --now "$u" >/dev/null 2>&1 || true; done
  else
    for u in $units; do systemctl disable --now "$u" >/dev/null 2>&1 || true; done
    for f in "$@"; do case "$f" in *.sh) rm -f "$LIBEXEC/$f" ;; *) rm -f "$SYSTEMD/$f" ;; esac; done
  fi
}

smart=true; [ "${SMART:-true}" = false ] && smart=false
if [ "$smart" = true ] && ! command -v smartctl >/dev/null 2>&1 && command -v apt-get >/dev/null 2>&1; then
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq smartmontools >/dev/null || echo "hlm-agent install: smartmontools not installed, SMART disabled" >&2
fi
helper "$smart" hlm-agent-smart.timer smart-collect.sh hlm-agent-smart.service hlm-agent-smart.timer
[ "$smart" = true ] && { systemctl start hlm-agent-smart.service || true; }

remote=true; [ "${REMOTE_UPDATES:-true}" = false ] && remote=false
helper "$remote" hlm-agent-apt.path apt-action.sh hlm-agent-apt.path hlm-agent-apt.service

docker=${DOCKER:-auto}
if [ "$docker" = auto ]; then if command -v docker >/dev/null 2>&1; then docker=true; else docker=false; fi; fi
dockerunits=hlm-agent-docker.timer; [ "$remote" = true ] && dockerunits="$dockerunits hlm-agent-docker-update.path"
helper "$docker" "$dockerunits" docker-helper.sh hlm-agent-docker.service hlm-agent-docker.timer \
  hlm-agent-docker-update.path hlm-agent-docker-update.service
[ "$docker" = true ] && [ "$remote" = false ] && systemctl disable --now hlm-agent-docker-update.path >/dev/null 2>&1
[ "$docker" = true ] && { systemctl start hlm-agent-docker.service || true; }

systemctl daemon-reload
systemctl enable hlm-agent >/dev/null 2>&1
systemctl restart hlm-agent || true
sleep 2
# Unprivileged LXC containers without nesting cannot set up the service sandbox
# (mount namespaces): fall back to running without those protections there only.
if ! systemctl is-active -q hlm-agent && systemd-detect-virt -cq 2>/dev/null; then
  install -d -m 0755 "$SYSTEMD/hlm-agent.service.d"
  cat > "$SYSTEMD/hlm-agent.service.d/container.conf" <<'EOF'
# Written by install.sh: this container cannot create the sandbox of hlm-agent.service.
[Service]
ProtectSystem=no
ProtectHome=no
PrivateTmp=no
PrivateDevices=no
ProtectKernelTunables=no
ProtectKernelModules=no
ProtectKernelLogs=no
ProtectControlGroups=no
ProtectClock=no
ProtectHostname=no
RestrictNamespaces=no
EOF
  systemctl daemon-reload
  systemctl restart hlm-agent || true
  sleep 2
fi
systemctl is-active -q hlm-agent || die "hlm-agent did not start, see: journalctl -u hlm-agent -n 30"
echo "hlm-agent $("$PREFIX/hlm-agent" --version) installed and running on $(hostname)"

# Proxmox: install the same files in every running Debian LXC container.
if [ "${LXC:-}" = all ]; then
  command -v pct >/dev/null 2>&1 || die "LXC=all only works on a Proxmox host"
  ctoken=${LXC_TOKEN:-${TOKEN:-}}
  case "$ctoken" in enr_*) ;; *) die "LXC=all needs a shared enrollment token: LXC_TOKEN=enr_… (Hôtes → Déploiement en masse)" ;; esac
  conf() { sed -n "s/^$1=//p" "$CONF" | head -n1; }
  chub=${HUB_URL:-$(conf HUB_URL)}; ckey=${KEY:-$(conf KEY)}; cinsecure=${ALLOW_INSECURE:-$(conf ALLOW_INSECURE)}
  ok=0; failed=0
  for ct in $(pct list | awk 'NR > 1 && $2 == "running" { print $1 }'); do
    name=$(pct config "$ct" | sed -n 's/^hostname: //p')
    if ! pct exec "$ct" -- sh -c 'test -f /etc/debian_version && command -v systemctl' >/dev/null 2>&1; then
      echo "  CT $ct ($name): not Debian with systemd, skipped"; continue
    fi
    pct exec "$ct" -- sh -c 'rm -rf /tmp/hlm-bundle && mkdir -m 0700 /tmp/hlm-bundle'
    for f in hlm-agent sum $FILES; do pct push "$ct" "$TMP/$f" "/tmp/hlm-bundle/$f"; done
    if pct exec "$ct" -- env HUB_URL="$chub" TOKEN="$ctoken" KEY="$ckey" ALLOW_INSECURE="$cinsecure" \
         AUTO_UPDATE="${AUTO_UPDATE:-}" SMART=false REMOTE_UPDATES="$remote" REPO="$REPO" BUNDLE=/tmp/hlm-bundle \
         sh /tmp/hlm-bundle/install.sh >/dev/null; then
      echo "  CT $ct ($name): installed"; ok=$((ok + 1))
    else
      echo "  CT $ct ($name): FAILED (pct enter $ct, then journalctl -u hlm-agent)"; failed=$((failed + 1))
    fi
    pct exec "$ct" -- rm -rf /tmp/hlm-bundle || true
  done
  echo "LXC containers: $ok installed, $failed failed"
fi
