# MQTT to MeshCore.io Map Bridge

> Warning: This software was built with heavy use of GPT-5.5. Use it at your own risk. Forks and rewrites without the help of a "clanker" are completely welcome.

MQTT to MeshCore.io Map bridge that listens to a MeshCore MQTT broker and uploads verified MeshCore adverts to the MeshCore.io map.

The service consumes MQTT observer messages, validates MeshCore packet data, signs accepted map uploads, and posts them to MeshCore.io. It does not run an MQTT broker and does not forward messages to another MQTT broker.

## What It Does

- Subscribes to MeshCore MQTT observer topics such as `meshcore/#`.
- Reads `status` messages to remember observer radio parameters.
- Reads `raw` and `packets` messages to find original MeshCore packet bytes.
- Verifies MeshCore advert signatures.
- Uploads only `REPEATER`, `ROOM`, and `SENSOR` adverts.
- Skips chat adverts, invalid packets, stale replays, and too-frequent reuploads.
- Signs every upload with one MeshCore.io identity: ephemeral per start by default, or a fixed identity via `MESHCOREIO_PRIVATE_KEY`.
- Logs generated public keys, but never logs private keys.
- Logs exactly one line per meshcore.io exchange: which advert was sent and how the server responded.

Internally this is split into three responsibilities:

- MQTT broker reader: connects to the source broker, validates adverts, deduplicates repeated observations, and attaches observer radio settings.
- Posting queue: accepts advert jobs, keeps duplicate nodes out of the queue, and requeues connection failures at the back.
- MeshCore.io poster: drains the queue sequentially (one upload at a time with a short pacing delay), signs each request with the service's signing identity, posts to MeshCore.io, and treats terminal server responses as handled.

## Configuration

Copy `.env.example` and provide at least:

```env
SOURCE_MQTT_URL=mqtt://your-broker:1883
SOURCE_MQTT_USERNAME=
SOURCE_MQTT_PASSWORD=
TOPIC_FILTER=meshcore/#
```

By default the service generates a fresh ephemeral MeshCore.io signing identity at every start and writes its public key to the logs. Set `MESHCOREIO_PRIVATE_KEY` to a 64-character hex ed25519 private seed to use a stable identity across restarts instead; invalid values abort startup. Private keys are kept in memory only and are never logged.

The MQTT source should publish observer `status` messages and MeshCore packet messages on `raw` or `packets` topics. For the expected message formats, conversion flow, signing details, and MeshCore.io request shape, see [TECHNICAL.md](TECHNICAL.md).

Important runtime settings:

- `MESHCOREIO_PRIVATE_KEY`: optional fixed ed25519 signing seed (64 hex characters) for a stable uploader identity. Unset by default.
- `MESHCOREIO_DRY_RUN`: run the full reader and queue flow but do not post to MeshCore.io. Default: `false`.
- `MESHCOREIO_MAX_QUEUED_UPLOADS`: maximum number of queued upload requests waiting for the poster. Default: `25`.
- `MESHCOREIO_RETRIES_ALLOWED`: retry budget placed on each new queue work request. Default: `3`.
- `MESHCOREIO_REQUEST_TIMEOUT_MS`: HTTP timeout for MeshCore.io requests, covering the response body read. Default: `10000`.
- `MESHCOREIO_MIN_REUPLOAD_SECONDS`: minimum accepted advert timestamp gap per advertised node. Default: `3600`.
- `TZ`: time zone used for service log timestamps, for example `Europe/Stockholm`.

Uploads are drained strictly one at a time; after each upload the poster waits 5 seconds before taking the next queued request. Failed attempts go to the back of the queue with one retry removed and are silent unless the retry budget is exhausted, which produces a single warning. If the queue is full, new requests are dropped with a warning. Multiple observers hearing the same advert produce at most one upload and one log line.

Numeric environment variables are range-checked. Invalid or unreasonably large values fall back to safe defaults.

## Deployment

The recommended deployment path is Docker Compose.

Copy the example files:

```bash
cp compose.yaml.example compose.yaml
cp .env.example .env
```

Edit `.env` and set the correct MQTT broker information:

```env
SOURCE_MQTT_URL=mqtt://your-broker:1883
SOURCE_MQTT_USERNAME=
SOURCE_MQTT_PASSWORD=
TOPIC_FILTER=meshcore/#
```

### Multiple MQTT Sources

For several brokers, use numbered variables instead — each source gets its own connection, client ID, and topic filter:

```env
SOURCE_1_NAME=Primary Broker
SOURCE_1_MQTT_URL=mqtt://broker1.example:1883
SOURCE_1_MQTT_USERNAME=user1
SOURCE_1_MQTT_PASSWORD=pass1
SOURCE_2_NAME=Secondary Broker
SOURCE_2_MQTT_URL=mqtt://broker2.example:1883
```

`SOURCE_N_RECONNECT_PERIOD_MS`, `SOURCE_N_CONNECT_TIMEOUT_MS`, and `SOURCE_N_REJECT_UNAUTHORIZED` override the global defaults per source. See `.env.example` for the full list.

`SOURCE_MQTT_URL` is passed to MQTT.js and can use standard MQTT URL schemes:

```env
SOURCE_MQTT_URL=mqtt://your-broker:1883
SOURCE_MQTT_URL=mqtts://your-broker:8883
SOURCE_MQTT_URL=ws://your-broker:8083/mqtt
SOURCE_MQTT_URL=wss://your-broker:8084/mqtt
```

Keep `SOURCE_REJECT_UNAUTHORIZED=true` for normal `mqtts://` and `wss://` deployments. Set it to `false` only for local tests with self-signed certificates.

If the MQTT broker runs in the same Compose stack, set `SOURCE_MQTT_URL` to that service name. If it runs elsewhere, use its DNS name or reachable host IP. Inside a container, `localhost` means the container itself, not the Docker host.

Start the bridge:

```bash
docker compose up -d
```

The Compose example uses the published GitHub Container Registry image, sets `LOG_COLOR=false`, enables log rotation, and applies basic container hardening. The service is fully in-memory and needs no writable volume, so the example runs with `read_only: true`.

Images are published to both `ghcr.io/bjorkan/mqtt-to-meshcoreio-map` and `bjorkan/mqtt-to-meshcoreio-map` on Docker Hub. The `edge` tag tracks the latest push to `main`; the `latest` tag tracks the latest published GitHub release.

For testing, the published image can also be run directly with the MQTT settings in the command:

```bash
docker run --rm \
  -e SOURCE_MQTT_URL=mqtt://your-broker:1883 \
  -e SOURCE_MQTT_USERNAME= \
  -e SOURCE_MQTT_PASSWORD= \
  -e SOURCE_REJECT_UNAUTHORIZED=true \
  -e TOPIC_FILTER=meshcore/# \
  ghcr.io/bjorkan/mqtt-to-meshcoreio-map:latest
```

## Removed Environment Variables

These variables from older releases are no longer read and can be removed from your environment:

- `MESHCOREIO_WORKERS` — uploads always run one at a time now.
- `ENABLE_DASHBOARD`, `DASHBOARD_PORT`, `DASHBOARD_DEMO_ADVERTS` — the web dashboard was removed.
- `TURSO_PATH`, `SQLITE_PATH` — the database was removed; state is memory-only.

Note that observer radio parameters are memory-only as well: after a restart they are empty until each observer publishes a new `status` message.

## Development

The project runs on [Bun](https://bun.sh):

```bash
bun install
bun run typecheck
bun test
bun run lint
bun run format
docker build -t mqtt-to-meshcoreio-map .
```
