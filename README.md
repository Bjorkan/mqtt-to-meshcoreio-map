# MQTT to MeshCore.io Map

**Put MeshCore nodes heard by MQTT observers on the [MeshCore.io map](https://map.meshcore.io/).**

This bridge subscribes to an existing MQTT broker, pairs observer radio status with received MeshCore packets, verifies advert signatures, and uploads eligible `REPEATER`, `ROOM`, and `SENSOR` adverts. It does **not** run an MQTT broker, relay messages, provide a dashboard, or store data in a database.

## Get started with Docker Compose

1. Copy the examples:

   ```bash
   cp compose.yaml.example compose.yaml
   cp .env.example .env
   ```

2. Edit `.env` with your broker's connection details. Uncomment the single-source settings and **quote wildcard topics** (`#` otherwise begins a dotenv comment):

   ```dotenv
   SOURCE_MQTT_URL=wss://broker.example.com/mqtt
   SOURCE_MQTT_USERNAME=your-subscriber-name
   SOURCE_MQTT_PASSWORD=your-subscriber-password
   TOPIC_FILTER="meshcore/#"
   ```

   The broker must supply observer `status` and `raw` or `packets` messages. A valid observer status must arrive before its packets can be uploaded. See [message formats](TECHNICAL.md#mqtt-input-contract).

3. Start the service and follow its logs:

   ```bash
   docker compose up -d
   docker compose logs -f
   ```

The example uses `ghcr.io/bjorkan/mqtt-to-meshcoreio-map:latest`. It needs no inbound ports or writable volume. Docker Hub users can substitute `bjorkan/mqtt-to-meshcoreio-map:latest`. The `latest` tag follows published releases; `edge` follows `main` and may be less stable.

> **Test safely:** Set `MESHCOREIO_DRY_RUN=true` in `.env` while checking a new broker. The bridge will read and verify adverts but will **not** send requests to MeshCore.io. Switch it back to `false` only when you're ready to upload real observations.

## How it behaves

| Stage    | What happens                                                                                                                                |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Listen   | Connect to one or more MQTT brokers and subscribe to observer topics.                                                                       |
| Validate | Remember the latest valid radio settings for each observer for up to 24 hours; verify packet signatures and accept only uploadable adverts. |
| Upload   | Deduplicate nodes, sign requests with one upload identity, and post sequentially with a 5-second gap while jobs are waiting.                |

State is **memory-only**. Restarting clears observer status, deduplication, and pending uploads. Observers need to publish a new valid `status` message after restart. The service subscribes with MQTT QoS 0 and a clean session, so messages published while disconnected are not guaranteed to be replayed.

### Multiple MQTT brokers

Use contiguous numbered sources instead of the single-source variables:

```dotenv
SOURCE_1_NAME=Primary broker
SOURCE_1_MQTT_URL=wss://broker-one.example.com/mqtt
SOURCE_1_MQTT_USERNAME=reader-one
SOURCE_1_MQTT_PASSWORD=your-password
SOURCE_1_TOPIC_FILTER="meshcore/#"
SOURCE_2_NAME=Backup broker
SOURCE_2_MQTT_URL=mqtts://broker-two.example.com:8883
SOURCE_2_MQTT_USERNAME=reader-two
SOURCE_2_MQTT_PASSWORD=your-other-password
SOURCE_2_TOPIC_FILTER="meshcore/#"
```

Start at `SOURCE_1_MQTT_URL` without gaps; each source has its own connection and client ID. Supported URL schemes are `mqtt://`, `mqtts://`, `ws://`, and `wss://`. Keep `SOURCE_REJECT_UNAUTHORIZED=true` for TLS in normal deployments. See [`.env.example`](.env.example) for per-source timeout, reconnect, and TLS overrides.

### Upload identity and controls

| Variable                          | Default          | Purpose                                                              |
| --------------------------------- | ---------------- | -------------------------------------------------------------------- |
| `MESHCOREIO_DRY_RUN`              | `false`          | Process adverts without making HTTP requests.                        |
| `MESHCOREIO_PRIVATE_KEY`          | Unset            | Optional 64-hex-character Ed25519 seed for a stable upload identity. |
| `MESHCOREIO_MAX_QUEUED_UPLOADS`   | `25`             | Maximum waiting uploads (not including the active one).              |
| `MESHCOREIO_RETRIES_ALLOWED`      | `3`              | Maximum attempts per job, including the first. `0` disables posting. |
| `MESHCOREIO_REQUEST_TIMEOUT_MS`   | `10000`          | Timeout for the complete HTTP exchange.                              |
| `MESHCOREIO_MIN_REUPLOAD_SECONDS` | `3600`           | Minimum advert-timestamp gap for a previously handled node.          |
| `TZ`                              | System time zone | IANA time zone for log timestamps, such as `Europe/Stockholm`.       |

An ephemeral upload identity is generated at every start unless `MESHCOREIO_PRIVATE_KEY` is set. Only its **public** key appears in logs; keep the private seed secret. Invalid seeds prevent startup. Use a stable identity if the map should recognize uploads from successive restarts as coming from the same uploader.

The queue is bounded and drains one job at a time. Full queues produce a warning and drop new work; failed attempts go to the back of the queue without per-attempt logging. A job that exhausts its attempts produces one warning. Accepted responses produce one outcome line per MeshCore.io exchange.

## Troubleshooting

- **No MQTT connection:** Check the URL, credentials, TLS certificates, and whether the broker supports the selected transport. A WebSocket-only broker needs `ws://` or `wss://`, not `mqtt://`. Inside Docker, `localhost` refers to the bridge container; use a reachable hostname or Compose service name.
- **Connected, but no uploads:** Verify the topic filter and observer `status` messages, then look for valid `raw` or `packets` messages from the same observer. Check that dry run is off when real uploads are intended. Invalid signatures, unsupported advert types, and cooldown drops are intentionally quiet.
- **A node is missing after restart:** Observer radio state is not persisted; wait for a new valid `status` message. Check for a full queue warning or an exhausted-attempt warning.
- **Upgrading from older releases:** `ENABLE_DASHBOARD`, `DASHBOARD_PORT`, `DASHBOARD_DEMO_ADVERTS`, `TURSO_PATH`, `SQLITE_PATH`, and `MESHCOREIO_WORKERS` are no longer used. There is no dashboard or database to migrate.

## For contributors

The application is a Rust binary in [`rust/`](rust/). [`rust/tests/`](rust/tests/) checks its protocol, configuration, queue, HTTP behavior, and local end-to-end flow. See [technical details](TECHNICAL.md) for the MQTT contract, signed request, and runtime flow.

```bash
cargo fmt --manifest-path rust/Cargo.toml --check
cargo clippy --manifest-path rust/Cargo.toml --all-targets --all-features --locked -- -D warnings
cargo test --manifest-path rust/Cargo.toml --all-targets --locked
docker build -t mqtt-to-meshcoreio-map .
```

Before a production rollout, validate your unmodified Compose configuration and the bridge's effective settings **without connecting to MQTT or MeshCore.io**, then test with dry run enabled:

```bash
docker compose config --quiet
docker compose run --rm --no-deps mqtt-to-meshcoreio-map \
  /app/mqtt-to-meshcoreio-map --check-config
# Set MESHCOREIO_DRY_RUN=true in .env before starting the service.
docker compose up -d
docker compose logs -f
```

Run a staging dry run against the actual broker before enabling uploads. Keep real credentials out of version control.

> **Disclaimer:** This project was built with extensive AI assistance (GPT-5.5). Review it and use it at your own risk; human-written forks and rewrites are welcome.
