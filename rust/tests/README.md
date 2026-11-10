# Rust tests and reference vectors

This directory checks that the bridge accepts the right adverts and handles configuration, queues, signing, errors, and shutdown safely—without a JavaScript runtime or live map uploads.

- `golden.rs`, `protocol.rs`, `runtime.rs`: check configuration, packet handling, and signed request data against static vectors in [`fixtures/`](fixtures/).
- `end_to_end.rs`: drive the Rust executable against **local** MQTT and HTTP peers and compare its signed request with a reference vector.
- `queue.rs`, `uploader.rs`: check bounded queue behavior, signatures, response handling, and timeouts.
- `compose-smoke.sh`: start and check the example Compose service against a locally built image.

Run from the repository root:

```bash
cargo test --manifest-path rust/Cargo.toml --all-targets --locked
docker build -t mqtt-to-meshcoreio-map .
bash rust/tests/compose-smoke.sh mqtt-to-meshcoreio-map:latest
```

The JSON vectors are fixed reference data, not generated from the Rust implementation during a test. See [`fixtures/README.md`](fixtures/README.md) for provenance and maintenance guidance.
