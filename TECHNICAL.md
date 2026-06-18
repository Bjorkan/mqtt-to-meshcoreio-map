# Technical Details

This document describes the MQTT input contract, MeshCore.io upload format, and conversion flow used by the bridge. For deployment and project overview, see [README.md](README.md).

## MQTT Input Contract

The service receives MQTT messages through the configured `TOPIC_FILTER`, usually `meshcore/#`. The message type is read from any topic segment named `status`, `raw`, or `packets`.

The MQTT client uses a clean session and subscribes with QoS 0. This keeps the bridge simple and avoids retained delivery state, but it also means messages can be missed during disconnects or reconnects. The expected source is a live observer stream where later adverts can refresh map state.

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

## Status Messages

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

Only the latest valid status for each observer is kept. Invalid, offline, or incomplete status messages do not overwrite the latest valid radio parameters. Observer status older than 24 hours is dropped.

## Packet Messages

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
8. Put eligible adverts through a bounded global upload queue.
9. Skip stale adverts, duplicate in-flight adverts, too-frequent reuploads, adverts without complete valid radio parameters, and adverts received during global API cooldown.
10. Build MeshCore.io upload data with normalized radio params and a `meshcore://...` link containing the original packet bytes.
11. Sign the upload with the in-memory ephemeral private key.
12. POST the signed request to MeshCore.io and log the API result.

Deduplication, replay protection, observer radio state, in-flight uploads, and cooldowns are kept in memory. A service restart starts with an empty local cache; MeshCore.io may still apply its own duplicate handling.

If the same advert is heard by multiple observers, the bridge uploads the first accepted copy for that advertised node/timestamp. Later copies with different observer radio data may be skipped by duplicate and reupload protection.
