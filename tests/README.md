# Bun tests and golden fixtures

This folder tests the original Bun bridge and generates reference fixtures used by Rust parity tests. It does not connect to the live MeshCore.io map.

| Area                                                             | What it covers                                                                                               |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `mqtt-reader/`, `queue/`, `meshcoreio-poster/`                   | Message parsing, bounded scheduling, signing, and HTTP outcomes.                                             |
| `config-golden.mjs`, `protocol-golden.mjs`, `runtime-golden.mjs` | Generate JSON reference vectors for Rust comparison.                                                         |
| `compose-smoke.sh`                                               | Start the example Compose configuration against a local image and check startup; it does not upload adverts. |

Run `bun test` from the repository root. To refresh reference files after an intentional behavior change, run the three `*-golden.mjs` scripts with Bun and review the resulting JSON diff before running the Rust tests. For usage and deployment, see the [main README](../README.md).
