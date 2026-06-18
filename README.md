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
- Generates a new ephemeral MeshCore.io upload identity on each start.
- Logs the generated public key, but never logs the private key.

## Configuration

Copy `.env.example` and provide at least:

```env
SOURCE_MQTT_URL=mqtt://your-broker:1883
SOURCE_MQTT_USERNAME=
SOURCE_MQTT_PASSWORD=
TOPIC_FILTER=meshcore/#
```

The service creates a fresh MeshCore.io signing identity every time it starts. The public key is written to the logs so you can see which uploader identity is being used for that run. The private key is generated in memory only and is not logged.

The MQTT source should publish observer `status` messages and MeshCore packet messages on `raw` or `packets` topics. For the expected message formats, conversion flow, signing details, and MeshCore.io request shape, see [TECHNICAL.md](TECHNICAL.md).

Important runtime settings:

- `MESHCOREIO_MAX_CONCURRENT_UPLOADS`: maximum number of upload workers draining the global advert upload queue. Default: `2`.
- `MESHCOREIO_MAX_QUEUED_UPLOADS`: maximum number of queued upload requests waiting for a worker. Default: `25`.
- `MESHCOREIO_REQUEST_TIMEOUT_MS`: HTTP timeout for MeshCore.io requests. Default: `10000`.
- `MESHCOREIO_MIN_REUPLOAD_SECONDS`: minimum accepted advert timestamp gap per advertised node. Default: `3600`.

Failed MeshCore.io upload attempts are placed at the back of the global queue and retried up to three total tries. After each upload job, the worker waits 5 seconds before taking another queued request. If the queue is full, extra upload requests are dropped.

Numeric environment variables are range-checked. Invalid, negative, zero-where-not-allowed, or unreasonably large values fall back to safe defaults.

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

The Compose example uses the published GitHub Container Registry image, sets `LOG_COLOR=false`, enables log rotation, applies basic container hardening, and uses a conservative first-release `MESHCOREIO_MAX_CONCURRENT_UPLOADS=1`.

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
