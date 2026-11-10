# Rust crate instructions

Scope: `rust/`. Follow the root `AGENTS.md`; `src/AGENTS.md` and `tests/AGENTS.md` refine instructions for their subdirectories.

## Compatibility and builds

- `Cargo.toml`/`Cargo.lock` describe the production binary. Keep the lockfile committed and use `--locked` in tests and builds.
- Config resolution and dotenv expansion in `src/lib.rs` must retain the public environment contract; run `cargo test --manifest-path rust/Cargo.toml --test golden --locked` when changing env handling.
- The runtime is intentionally Linux-container-friendly and memory-only. Do not add inbound ports, database migrations, writable volumes, or a second upload process.
- Keep source-relative paths in documentation accurate: from the repository root use `--manifest-path rust/Cargo.toml`.

## Required crate checks

```bash
cargo fmt --manifest-path rust/Cargo.toml --check
cargo clippy --manifest-path rust/Cargo.toml --all-targets --all-features --locked -- -D warnings
cargo test --manifest-path rust/Cargo.toml --all-targets --locked
cargo build --manifest-path rust/Cargo.toml --release --locked
```

For runtime changes also run `docker build -t mqtt-to-meshcoreio-map .` and `bash rust/tests/compose-smoke.sh mqtt-to-meshcoreio-map:latest`. Do not use the live API for tests; use local fixtures or dry run.
