#!/usr/bin/env bash
# Rebuild and restart the QoreBills agent from the code checked out here, then wait for
# its health check. The Deploy workflow runs this on the VM after writing .env.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "No .env here; the Deploy workflow writes it from the repository secrets." >&2
  exit 1
fi
if docker info >/dev/null 2>&1; then DOCKER=(docker); else DOCKER=(sudo docker); fi

# The network Caddy (from the claude-tools deployment) uses to reach this container.
"${DOCKER[@]}" network inspect edge >/dev/null 2>&1 || "${DOCKER[@]}" network create edge >/dev/null

# A little swap keeps npm and the Docker build from running out of memory on a 1 GB VM.
if [ "$(swapon --show --noheadings | wc -l)" = "0" ] && [ ! -f /swapfile ]; then
  sudo fallocate -l 1G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile >/dev/null && sudo swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

echo "Deploying $(git rev-parse --short HEAD)"
"${DOCKER[@]}" compose up -d --build --remove-orphans
"${DOCKER[@]}" image prune -f >/dev/null

for _ in $(seq 1 30); do
  status="$("${DOCKER[@]}" inspect -f '{{.State.Health.Status}}' qorebills 2>/dev/null || echo unknown)"
  if [ "$status" = "healthy" ]; then
    echo "QoreBills agent is healthy."
    "${DOCKER[@]}" compose logs --tail 5 qorebills
    exit 0
  fi
  sleep 5
done
echo "Not healthy after 150s ($status). Recent logs:" >&2
"${DOCKER[@]}" compose logs --tail 50 qorebills >&2
exit 1
