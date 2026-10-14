#!/bin/sh
# Docker access for hlm-agent. Reading the Docker socket is root-equivalent, so the
# unprivileged agent never touches it: this root-owned script does, in two modes.
#   collect  (hlm-agent-docker.timer, every minute, no network): writes `docker inspect`,
#            `docker stats` and image metadata to /var/lib/hlm-agent/docker/snapshot/.
#   update   (hlm-agent-docker-update.path, when the agent drops a request): takes one
#            container name, and only for Docker Compose containers runs
#            `docker compose pull <service> && docker compose up -d <service>`.
set -u
OUT=/var/lib/hlm-agent/docker
command -v docker >/dev/null 2>&1 || exit 0
install -d -o root -g hlm-agent -m 0750 "$OUT"

publish() { # $1 = file to move into $OUT, readable by the agent
  chgrp hlm-agent "$1" && chmod 0640 "$1"
}

collect() {
  new="$OUT/.snapshot.new"
  rm -rf "$new"; mkdir -m 0750 "$new"
  ids=$(docker ps -aq --no-trunc 2>"$new/error") || { publish "$new/error"; }
  if [ -n "${ids:-}" ]; then
    # shellcheck disable=SC2086 # ids are hex, one per word
    docker inspect $ids > "$new/inspect.json" 2>/dev/null || echo '[]' > "$new/inspect.json"
    docker stats --no-stream --no-trunc --format '{{json .}}' > "$new/stats.jsonl" 2>/dev/null || : > "$new/stats.jsonl"
    imgs=$(docker inspect --format '{{.Image}}' $ids 2>/dev/null | sort -u)
    [ -n "$imgs" ] && docker image inspect $imgs > "$new/images.json" 2>/dev/null
  fi
  [ -s "$new/error" ] || rm -f "$new/error"
  for f in "$new"/*; do [ -e "$f" ] && publish "$f"; done
  chgrp hlm-agent "$new"
  rm -rf "$OUT/.snapshot.old"
  [ -d "$OUT/snapshot" ] && mv "$OUT/snapshot" "$OUT/.snapshot.old"
  mv "$new" "$OUT/snapshot"
  rm -rf "$OUT/.snapshot.old"
}

status() { # state exit_code
  printf '{"action":"update_container","target":"%s","state":"%s","exit_code":%s,"finished_at":%s}\n' "$name" "$1" "$2" "$(date +%s)" > "$OUT/update-status.tmp"
  publish "$OUT/update-status.tmp"; mv "$OUT/update-status.tmp" "$OUT/update-status.json"
}

update() {
  req=/var/lib/hlm-agent/state/docker-request
  [ -f "$req" ] && [ ! -L "$req" ] || { rm -f "$req"; exit 0; }
  name=$(head -c 200 "$req" | tr -dc 'A-Za-z0-9_.-')
  rm -f "$req"
  [ -n "$name" ] || exit 0
  log="$OUT/update-log"
  : > "$log"; publish "$log"
  status running null
  label() { docker inspect --format "{{index .Config.Labels \"$1\"}}" "$name" 2>>"$log"; }
  project=$(label com.docker.compose.project); dir=$(label com.docker.compose.project.working_dir)
  files=$(label com.docker.compose.project.config_files); service=$(label com.docker.compose.service)
  if [ -z "$project" ] || [ -z "$dir" ] || [ -z "$service" ] || [ ! -d "$dir" ]; then
    echo "Le conteneur $name n'est pas géré par Docker Compose (ou son dossier n'existe plus) : mettez-le à jour avec la commande qui l'a créé." >> "$log"
    status failed 1; exit 0
  fi
  if docker compose version >/dev/null 2>&1; then set -- docker compose; else set -- docker-compose; fi
  set -- "$@" -p "$project"
  old_ifs=$IFS; IFS=,
  for f in $files; do set -- "$@" -f "$f"; done
  IFS=$old_ifs
  cd "$dir" || { status failed 1; exit 0; }
  echo "\$ $* pull $service && $* up -d $service" >> "$log"
  if "$@" pull "$service" >> "$log" 2>&1 && "$@" up -d "$service" >> "$log" 2>&1; then
    status done 0
  else
    status failed $?
  fi
  collect
}

case "${1:-}" in
  collect) collect ;;
  update) update ;;
  *) echo "usage: $0 collect|update" >&2; exit 2 ;;
esac
