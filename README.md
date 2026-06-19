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
- Generates a new ephemeral MeshCore.io upload identity for each worker on each start.
- Logs generated public keys, but never logs private keys.
- Can expose an optional read-only in-memory dashboard with reader decisions, queue state, worker state, and advert coordinates from the last hour.

Internally this is split into three responsibilities:

- MQTT broker reader: connects to the source broker, validates adverts, deduplicates repeated observations, and attaches observer radio settings.
- Posting queue: accepts advert jobs, keeps duplicate nodes out of the queue, reports queue position, and requeues connection failures at the back.
- MeshCore.io poster: drains the queue with one or more workers, signs each request with that worker's ephemeral keypair, posts to MeshCore.io, and treats terminal server responses as handled.

## Configuration

Copy `.env.example` and provide at least:

```env
SOURCE_MQTT_URL=mqtt://your-broker:1883
SOURCE_MQTT_USERNAME=
SOURCE_MQTT_PASSWORD=
TOPIC_FILTER=meshcore/#
```

The service creates a fresh MeshCore.io signing identity for each worker every time it starts. Public keys are written to the logs so you can see which uploader identities are being used for that run. Private keys are generated in memory only and are not logged.

The MQTT source should publish observer `status` messages and MeshCore packet messages on `raw` or `packets` topics. For the expected message formats, conversion flow, signing details, and MeshCore.io request shape, see [TECHNICAL.md](TECHNICAL.md).

Important runtime settings:

- `MESHCOREIO_WORKERS`: number of upload workers draining the global advert upload queue. Default: `1`.
- `MESHCOREIO_DRY_RUN`: run the full reader and queue flow but prevent workers from posting to MeshCore.io. Default: `false`.
- `MESHCOREIO_MAX_QUEUED_UPLOADS`: maximum number of queued upload requests waiting for a worker. Default: `25`.
- `MESHCOREIO_RETRIES_ALLOWED`: retry budget placed on each new queue work request. Default: `3`.
- `MESHCOREIO_REQUEST_TIMEOUT_MS`: HTTP timeout for MeshCore.io requests. Default: `10000`.
- `MESHCOREIO_MIN_REUPLOAD_SECONDS`: minimum accepted advert timestamp gap per advertised node. Default: `3600`.
- `ENABLE_DASHBOARD`: enable the read-only dashboard. Default: `false`.
- `DASHBOARD_PORT`: internal dashboard listen port. Default: `80`.

Each worker creates its own ephemeral MeshCore.io signing identity at startup. In dry-run mode, workers still drain and validate queue work but do not make the final HTTP request to MeshCore.io. Failed MeshCore.io upload attempts are placed at the back of the global queue with one retry removed from the request. After each upload job, the worker waits 5 seconds before taking another queued request. If the queue is full or the request has no retries left, the request is dropped.

Numeric environment variables are range-checked. Invalid, negative, zero-where-not-allowed, or unreasonably large values fall back to safe defaults.

## Dashboard

Set `ENABLE_DASHBOARD=true` to serve a small read-only dashboard from the same process. It keeps data in memory only and clears everything on restart. The dashboard shows:

- MQTT reader decisions and map upload logs.
- Current queued and active advert upload jobs, with clickable JSON details.
- Worker state and the job each worker is handling.
- A read-only OpenStreetMap view for adverts with lat/lon received during the last hour.

The browser renders the dashboard from a single read-only JSON endpoint at `/api`.

In Docker Compose, publish the internal dashboard port `80` to host port `6543`:

```yaml
ports:
  - "6543:80"
```

Then open `http://localhost:6543`.

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

The Compose example uses the published GitHub Container Registry image, sets `LOG_COLOR=false`, enables log rotation, applies basic container hardening, and uses a conservative `MESHCOREIO_WORKERS=1`.

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

## Development

```bash
npm install
npm run build
npm test
docker build -t mqtt-to-meshcoreio-map .
```
