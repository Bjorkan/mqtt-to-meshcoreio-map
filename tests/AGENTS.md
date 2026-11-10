# Bun test and fixture instructions

Scope: `tests/`. Follow the root `AGENTS.md` and the Bun baseline rules in `src/AGENTS.md` when editing tests that exercise `src/`.

- Keep fixture generators (`*-golden.mjs`) authoritative. Regenerate corresponding JSON files with Bun after intentional contract changes; do not edit golden JSON by hand.
- Cover observer status, packet verification, replay/cooldown, queue limits, and signed request bytes. Use fake MQTT and HTTP peers; never send test adverts to the live map.
- `compose-smoke.sh` temporarily tags a locally built image and runs the example Compose service. Preserve its guard against replacing an existing container and restore/remove only the temporary tag it created.
- Run `bun test`, `bun run typecheck`, `bun run lint`, `bun run format:check`, and Rust parity tests for changes to fixtures or baseline behavior.
