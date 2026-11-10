# Repository guide for coding agents

This is a Rust MQTT-to-MeshCore.io map bridge. Read the nearest nested `AGENTS.md` before editing a module. Keep documentation, comments, tests, commit messages, and user-facing text in English.

## Where to work

- `rust/AGENTS.md`: Rust crate, build, and compatibility constraints.
- `rust/src/AGENTS.md`: production protocol, reader, queue, uploader, and MQTT runtime.
- `rust/tests/AGENTS.md`: Rust integration tests, reference vectors, and Compose smoke test.
- `README.md`: user setup and operation; `TECHNICAL.md`: wire formats and implementation details. Keep both accurate when behavior changes.

## Checks from the repository root

```bash
cargo fmt --manifest-path rust/Cargo.toml --check
cargo clippy --manifest-path rust/Cargo.toml --all-targets --all-features --locked -- -D warnings
cargo test --manifest-path rust/Cargo.toml --all-targets --locked
docker build -t mqtt-to-meshcoreio-map .
```

Run all checks before publishing meaningful runtime changes. CI also builds an ARM64 image. Never run test traffic against the real MeshCore.io endpoint: use `MESHCOREIO_DRY_RUN=true` or a local HTTP fixture.

## Invariants

- No dashboard, HTTP server, database, or writable volume. Observer status, deduplication, queue, and retry state are in memory.
- One signing identity per start, optionally fixed with `MESHCOREIO_PRIVATE_KEY`. Never log private seeds, unredacted MQTT credentials, or token-bearing URLs; logging the derived public key is expected.
- Only verified `REPEATER`, `ROOM`, and `SENSOR` adverts can be uploaded. The latest valid observer radio status expires after 24 hours.
- One sequential upload queue, with bounded waiting capacity (`MESHCOREIO_MAX_QUEUED_UPLOADS`) and a 5-second delay between jobs. Do not add parallel HTTP uploads or unbounded verification work.
- Keep advert drops and retries silent except for full-queue warnings and one warning on exhausted attempts. Log one outcome per MeshCore.io exchange.
- Changes to configuration, protocol, or signing must preserve the checked-in reference vectors unless a deliberate, documented contract change is required.

## References and review

- [Map uploader reference](https://github.com/recrof/map.meshcore.io-uploader) documents the API and signing, but connects to a USB companion rather than MQTT.
- [MeshCore observer firmware branch](https://github.com/agessaman/MeshCore/tree/mqtt-bridge-implementation-flex) helps check observer payload formats.
- [MeshCore MQTT broker](https://github.com/michaelhart/meshcore-mqtt-broker) is WebSocket-based; use local credentials and dry run for integration checks.
- Invoke `.opencode/agents/critical-reviewer.md` before **every commit** to catch bugs, type errors, and logical mistakes.
