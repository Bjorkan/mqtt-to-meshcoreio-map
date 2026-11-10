# Bun compatibility implementation

This folder contains the original TypeScript/Bun implementation of the MQTT-to-MeshCore.io bridge. The production container now runs the [Rust service](../rust/), but the Bun version remains a reference for configuration, advert handling, signed requests, and regression tests. It is not a separate dashboard or broker.

- `index.ts` connects to MQTT and resolves environment configuration.
- `mqtt-reader/` recognizes observer status and verified MeshCore adverts.
- `queue/` schedules bounded, sequential uploads.
- `meshcoreio-poster/` signs and posts map requests.
- `map-utils.ts`, `map-types.ts`, and `map-log.ts` hold shared behavior and types.

To run this historical implementation directly, use `bun src/index.ts` with your configured `.env`; set `MESHCOREIO_DRY_RUN=true` for testing. `Dockerfile.bun` at the repository root builds a comparison image. For normal deployments, use the [main README](../README.md).
