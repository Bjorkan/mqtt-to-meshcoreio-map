# Production Rust runtime instructions

Scope: `rust/src/`. Read `../../AGENTS.md` and `../AGENTS.md` for repository and crate rules.

- `lib.rs`: preserve configuration and dotenv parity with `src/index.ts`. Never print private seeds or credentials; errors should be safe to log.
- `service.rs`: one bounded channel feeds a single reader and upload queue. Only one HTTP request may be active; keep the 5-second pacing, graceful signal handling, and redacted source URL logs. MQTT source errors must not leak URLs or credentials.
- `reader.rs`/`protocol.rs`: require valid observer radio status and a verified `REPEATER`, `ROOM`, or `SENSOR` signature before queue admission. Keep 24-hour observer expiry, replay filtering, and bounded packet inputs.
- `queue.rs`: one active job plus at most `MESHCOREIO_MAX_QUEUED_UPLOADS` waiting jobs; retries go to the back and may be dropped if full. Do not introduce concurrent posters.
- `uploader.rs`: sign the SHA-256 digest of the exact serialized `data` string with Ed25519. Keep request timeouts, response-size limits, and bounded retry behavior. Dry run must never send HTTP.

Use `../tests/` for behavior and parity coverage, and update `../../TECHNICAL.md` if wire formats or control flow change. Never send test adverts to the real map endpoint.
