#!/usr/bin/env bash
# Brings up a local Zetaris platform plus RecallReach's fictional source database.
# Run inside WSL (Ubuntu) AFTER `docker login zetarishackathon.azurecr.io` succeeded there:
#   bash /mnt/c/Users/Balu/Documents/Codex/2026-10-23/new-chat-4/recallreach/integrations/zetaris/bring-up.sh
# Safe to rerun: each step is skipped or repeated harmlessly when already done.
# It never prints credentials and changes nothing outside Docker.
set -euo pipefail

ZETARIS_DIR="${ZETARIS_DIR:-$HOME/zetaris/zetaris-platform}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NETWORK="${ZETARIS_NETWORK:-zetaris_default}"
step() { printf '\n== %s\n' "$1"; }

cd "$ZETARIS_DIR"

step "1/6 Preflight (official check)"
./preflight.sh

step "2/6 Download images (about 4 GB the first time)"
docker compose pull

step "3/6 Start Zetaris"
docker compose up -d

step "4/6 Wait for one-time setup (bootstrap) to finish"
for _ in $(seq 1 90); do
  state=$(docker compose ps --all --format '{{.Service}} {{.State}} {{.ExitCode}}' 2>/dev/null | awk '$1=="bootstrap"{print $2" "$3}')
  case "$state" in
    "exited 0") echo "bootstrap finished (exit 0)"; break ;;
    exited*) echo "bootstrap failed: $state"; docker compose logs --tail=60 bootstrap; exit 1 ;;
    *) sleep 10 ;;
  esac
done
[ "$state" = "exited 0" ] || { echo "bootstrap still running after 15 minutes; rerun this script later"; exit 1; }
docker compose ps --all

step "5/6 Official verification (verify.sh)"
for attempt in 1 2 3; do
  if ./verify.sh; then break; fi
  [ "$attempt" = 3 ] && { echo "verify.sh failed three times"; exit 1; }
  echo "retrying verify.sh in 60 s (the guide says the UI can need a minute after bootstrap)"; sleep 60
done

step "6/6 RecallReach fixture sources on the Zetaris network"
docker compose -f "$REPO_DIR/integrations/zetaris/docker-compose.yml" up -d
if docker network inspect "$NETWORK" --format '{{range .Containers}}{{.Name}} {{end}}' | grep -qw recallreach-sources; then
  echo "recallreach-sources already attached to $NETWORK"
else
  docker network connect --alias recallreach-sources "$NETWORK" recallreach-sources
fi
docker run --rm --network "$NETWORK" -e PGCONNECT_TIMEOUT=10 postgres:16-alpine \
  psql -h recallreach-sources -U recallreach_reader -d recall_distributor -w -At \
  -c "select 'fixture reachable from the Zetaris network: ' || count(*) || ' dispatch rows' from dispatches"

printf '\nZetaris is running at http://localhost:3000 (this machine only).\n'
printf 'Next: sign in, change the default password, create an API key (docs/INTEGRATIONS.md).\n'
