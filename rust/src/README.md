# Production runtime modules

These Rust modules implement the executable shipped in the container:

| File          | Responsibility                                                                          |
| ------------- | --------------------------------------------------------------------------------------- |
| `main.rs`     | Load the environment, resolve configuration, start the service.                         |
| `lib.rs`      | Parse Bun-compatible dotenv and environment settings; validate the signing seed.        |
| `service.rs`  | Connect to MQTT sources, handle messages, pace uploads, log outcomes, and stop cleanly. |
| `reader.rs`   | Track observer radio status, extract packet bytes, and prepare eligible advert jobs.    |
| `protocol.rs` | Parse MeshCore advert packets and verify their Ed25519 signatures.                      |
| `queue.rs`    | Deduplicate and bound the one-at-a-time upload queue and retries.                       |
| `uploader.rs` | Sign MeshCore.io requests and post them with timeouts and bounded responses.            |

To run the application, follow the [repository setup](../../README.md). For message and request examples, see [technical details](../../TECHNICAL.md). These modules expose no web dashboard or API for visitors.
