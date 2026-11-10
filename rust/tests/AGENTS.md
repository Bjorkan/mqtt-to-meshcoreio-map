# Rust test instructions

Scope: `rust/tests/`. Follow the root and `rust/AGENTS.md` rules.

- Use only loopback MQTT and HTTP peers, disposable temp directories, or `MESHCOREIO_DRY_RUN=true`. Never upload fixtures to the real MeshCore.io map.
- Fixture JSON in `fixtures/` is a checked-in set of static reference vectors. Do not regenerate it from the implementation under test or hand-edit signing bytes to make an incorrect implementation pass. Add independently verified vectors for new protocol cases.
- Maintain coverage for invalid signatures, unsupported advert types, queue capacity, HTTP timeout, credential-safe errors, and end-to-end MQTT-to-HTTP behavior.
- Keep production configuration and credentials out of tests and logs. Local Compose smoke tests must not upload adverts.
- Run `cargo test --manifest-path rust/Cargo.toml --all-targets --locked` from the repository root.
