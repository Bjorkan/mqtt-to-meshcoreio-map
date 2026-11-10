# Bun baseline instructions

Scope: `src/`. This is the retained compatibility reference, **not** the deployed binary. Follow the root `AGENTS.md` too.

- Preserve behavior needed by `rust/tests/` and fixture generators under `tests/`. When Bun semantics change deliberately, update both implementations, fixtures, and `TECHNICAL.md` together.
- `index.ts` owns source configuration and MQTT connection behavior; `map-utils.ts` owns common parsing. `mqtt-reader/` verifies adverts; `queue/` bounds sequential jobs; `meshcoreio-poster/` signs and sends requests.
- Do not reintroduce a dashboard, database, parallel posters, or logging of private seeds and MQTT credentials. Keep live-map integration tests in dry run or behind local HTTP mocks.
- Run `bun run typecheck`, `bun test`, `bun run lint`, and `bun run format:check` from the repository root for changes here. Regenerate golden fixtures when behavior changes.
