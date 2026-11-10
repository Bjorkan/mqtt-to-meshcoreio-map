#!/usr/bin/env bash
set -euo pipefail

image="${1:-mqtt-to-meshcoreio-map:ci}"
compose_image="ghcr.io/bjorkan/mqtt-to-meshcoreio-map:latest"
if docker container inspect mqtt-to-meshcoreio-map >/dev/null 2>&1; then
  echo "Refusing to replace an existing mqtt-to-meshcoreio-map container." >&2
  exit 1
fi
original_image="$(docker image inspect -f '{{.Id}}' "$compose_image" 2>/dev/null || true)"
tmp="$(mktemp -d)"
cleanup() {
  docker compose -f "$tmp/compose.yaml" -f "$tmp/smoke.override.yaml" down --remove-orphans >/dev/null 2>&1 || true
  if [ -n "$original_image" ]; then
    docker tag "$original_image" "$compose_image"
  else
    docker image rm "$compose_image" >/dev/null 2>&1 || true
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT

cp compose.yaml.example "$tmp/compose.yaml"
cp .env.example "$tmp/.env"
# Keep the example Compose file unchanged while forcing a safe smoke-only
# override, even if the example later enables uploads explicitly.
cat > "$tmp/smoke.override.yaml" <<'YAML'
services:
  mqtt-to-meshcoreio-map:
    environment:
      MESHCOREIO_DRY_RUN: "true"
      MESHCOREIO_API_URL: http://127.0.0.1:9/no-upload
YAML
docker tag "$image" "$compose_image"
docker compose -f "$tmp/compose.yaml" -f "$tmp/smoke.override.yaml" config --quiet
docker compose -f "$tmp/compose.yaml" -f "$tmp/smoke.override.yaml" run --rm --no-deps \
  mqtt-to-meshcoreio-map /app/mqtt-to-meshcoreio-map --check-config
docker compose -f "$tmp/compose.yaml" -f "$tmp/smoke.override.yaml" up -d --no-build --pull never

for _ in {1..30}; do
  if docker compose -f "$tmp/compose.yaml" -f "$tmp/smoke.override.yaml" logs --no-color 2>&1 | grep -Eq 'upload public key [0-9a-f]{64}' \
    && [ "$(docker inspect -f '{{.State.Running}}' mqtt-to-meshcoreio-map)" = "true" ]; then
    exit 0
  fi
  sleep 1
done
docker compose -f "$tmp/compose.yaml" -f "$tmp/smoke.override.yaml" logs --no-color
exit 1
