# MQTT to MeshCore.io Map

Standalone Docker service that listens to a MeshCore MQTT broker and uploads verified MeshCore adverts to the MeshCore.io map.

The map upload logic is extracted from `Bjorkan/meshcore-mqtt-broker` and kept focused on the MeshCore.io map flow only. This service does not run an MQTT broker and does not forward messages to another MQTT broker.

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

The MQTT messages should include:

- `status` payloads with `origin_id` and radio parameters: `freq`, `bw`, `sf`, and `cr`, or a compatible `radio` string.
- `packets` payloads with `raw`, or `raw` payloads with `data`.

The packet hex must be the original MeshCore packet wire bytes accepted by `Packet.fromBytes(...)`.

## MQTT Input Contract

The service receives MQTT messages through the configured `TOPIC_FILTER`, usually `meshcore/#`. The message type is read from any topic segment named `status`, `raw`, or `packets`.

The normal observer topic format is:

```text
meshcore/{REGION}/{OBSERVER_PUBLIC_KEY}/{type}
```

Examples:

```text
meshcore/STO/a1a1...a1/status
meshcore/STO/a1a1...a1/packets
meshcore/STO/a1a1...a1/raw
```

Custom topic layouts also work when either:

- the JSON payload contains a valid `origin_id`, or
- the topic contains a 64-character hex observer public key segment.

### Status Messages

`status` messages are JSON and are used to remember radio parameters for the observer that heard later packets. They are not uploaded to MeshCore.io directly.

Example:

```json
{
  "origin": "SE-STO-OBSERVER",
  "origin_id": "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
  "radio": "869.617981,62.5,8,8"
}
```

The radio settings can also be provided as direct fields:

```json
{
  "origin_id": "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
  "params": {
    "freq": 869.617981,
    "bw": 62.5,
    "sf": 8,
    "cr": 8
  }
}
```

Frequency may arrive as MHz, kHz, or Hz. Bandwidth may arrive as kHz or Hz. The uploader normalizes these to MHz and kHz before sending to MeshCore.io.

### Packet Messages

`packets` and `raw` messages carry the original MeshCore packet bytes as hex. The service accepts JSON payloads and plain hex strings.

For `packets`, the preferred field order is `raw`, `packet`, `payload`, then `data`:

```json
{
  "origin_id": "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
  "type": "PACKET",
  "raw": "0100..."
}
```

For `raw`, the preferred field order is `data`, `raw`, `packet`, then `payload`:

```json
{
  "origin_id": "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
  "type": "RAW",
  "data": "0100..."
}
```

The hex value must be even-length packet wire bytes, not a wrapper object, modem header, or MQTT envelope.

## MeshCore.io API Output

When an uploadable advert is found, the service posts to:

```text
https://map.meshcore.io/api/v1/uploader/node
```

The request body is signed and has this shape:

```json
{
  "data": "{\"params\":{\"freq\":869.618,\"bw\":62.5,\"sf\":8,\"cr\":8},\"links\":[\"meshcore://0100...\"]}",
  "signature": "128 hex chars",
  "publicKey": "64 hex chars"
}
```

`data` is a JSON string, not a nested JSON object. The `signature` is an Ed25519 signature over the SHA-256 hash of that string. The `publicKey` is the generated ephemeral upload public key for the current service run.

## Conversion Flow

1. Connect to the source MQTT broker and subscribe to `TOPIC_FILTER`.
2. For every MQTT message, inspect the topic to decide whether it is `status`, `raw`, or `packets`.
3. Store valid `status` radio parameters by observer public key.
4. Extract packet hex from `raw` or `packets` payloads and find the observer public key from `origin_id` or the topic.
5. Parse the packet with `Packet.fromBytes(...)`.
6. Continue only if the packet payload is a MeshCore `ADVERT`.
7. Parse the advert, verify its signature, and keep only `REPEATER`, `ROOM`, and `SENSOR` adverts.
8. Skip stale adverts, duplicate in-flight adverts, too-frequent reuploads, and adverts without complete valid radio parameters.
9. Build MeshCore.io upload data with normalized radio params and a `meshcore://...` link containing the original packet bytes.
10. Sign the upload with the in-memory ephemeral private key.
11. POST the signed request to MeshCore.io and log the API result.

## Docker

```bash
docker build -t mqtt-to-meshcoreio-map .
docker run --env-file .env mqtt-to-meshcoreio-map
```

Published images are pushed only to GitHub Container Registry:

```bash
docker pull ghcr.io/<owner>/<repo>:latest
docker run --env-file .env ghcr.io/<owner>/<repo>:latest
```

## Development

```bash
npm install
npm run build
npm test
```
