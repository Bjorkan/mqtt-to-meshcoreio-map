# Rust test instructions

Scope: `rust/tests/`. Follow the root and `rust/AGENTS.md` rules.

- Use only loopback MQTT and HTTP peers, disposable temp directories, or `MESHCOREIO_DRY_RUN=true`. Never upload fixtures to the real MeshCore.io map.
- Fixture JSON under `../../tests/` is generated from the retained Bun implementation; change its generator first, then regenerate and review the JSON. Do not hand-edit expected signing bytes to make Rust pass.
- Maintain coverage for invalid signatures, unsupported advert types, queue capacity, HTTP timeout, credential-safe errors, and Bun/Rust parity when behavior changes.
- The ignored production configuration test reads the operator's actual deployment files; it must not log resolved environment values or secrets. Do not enable it in CI without a supplied deployment directory.
- Run `cargo test --manifest-path rust/Cargo.toml --all-targets --locked` from the repository root; `end_to_end.rs` requires `bun` on `PATH`.
