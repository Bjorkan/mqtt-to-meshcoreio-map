# Rust behavior and compatibility tests

This directory checks that the production Rust bridge accepts the right adverts, matches the retained Bun implementation where required, and handles queues, signing, errors, and shutdown safely.

- `golden.rs`, `protocol.rs`, `runtime.rs`: compare configurations, packet handling, and request data with Bun-generated fixtures under [`../../tests/`](../../tests/).
- `end_to_end.rs`: drive both executables against **local** MQTT and HTTP peers and compare the resulting signed requests.
- `queue.rs`, `uploader.rs`: check bounded queue behavior, signatures, response handling, and timeouts.

Run from the repository root with `cargo test --manifest-path rust/Cargo.toml --all-targets --locked`. Bun must be available for the parity tests. An optional ignored test compares your own production `.env` and `compose.yaml` without printing their resolved values:

```bash
PRODUCTION_ENV_DIR=/path/to/deployment \
  cargo test --manifest-path rust/Cargo.toml --test golden -- --ignored
```

No test here requires a live MeshCore.io connection.
