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

Set `TZ` to an IANA time zone such as `Europe/Stockholm` to format service log timestamps in that time zone.

Only the latest valid status for each observer is kept. Invalid, offline, or incomplete status messages do not overwrite the latest valid radio parameters. Observer status older than 24 hours is dropped. Observer state is memory-only: after a restart it is empty until each observer publishes a new `status` message.

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

`data` is a JSON string, not a nested JSON object. The `signature` is an Ed25519 signature over the SHA-256 hash of that string. The `publicKey` is the service's upload identity: ephemeral per start by default, or derived from `MESHCOREIO_PRIVATE_KEY` when set.

## Runtime Responsibilities

The runtime is divided into three responsibilities:

1. MQTT broker reader

   The reader owns the MQTT message contract. It stores valid observer radio status, extracts packet bytes from `raw` and `packets` messages, parses and verifies MeshCore adverts, drops non-uploadable advert types, and deduplicates adverts already handled for a node within the configured reupload interval. It emits a compact JSON-serializable work request containing normalized observer radio params, the raw packet link source, advert identity, and log labels.

   Example queue work request:

   ```json
   {
     "requestId": "f8d0f0fb-783c-4a2e-b0c4-22a86b22b43b",
     "retriesAllowed": 3,
     "advertKey": "a09aa5...:1800091500",
     "advertTimestamp": 1800091500,
     "advertType": "REPEATER",
     "nodeName": "SE-STO-TEST",
     "nodePublicKey": "a09aa5...",
     "rawPacketHex": "0100...",
     "observerId": "a1a1a1...",
     "observerName": "SE-STO-OBSERVER",
     "radioParams": {
       "freq": 869.618,
       "bw": 62.5,
       "sf": 8,
       "cr": 8
     },
     "logContext": {
       "advertLabel": "SE-STO-TEST (a09aa5)"
     }
   }
   ```

2. Posting queue

   The queue receives work requests from the reader. It keeps at most one queued or active advert per advertised node and enforces `MESHCOREIO_MAX_QUEUED_UPLOADS`. Registering work is silent; when the queue is full, a warning is logged and the request is dropped.

   Connection and non-terminal upload failures are placed at the back of the queue with `retriesAllowed` reduced by one, without logging. When the retry budget reaches zero, exactly one warning is logged (`Advert <label> dropped after N attempts: <reason>`) and the request is dropped.

3. MeshCore.io poster

   The poster drains the queue sequentially: one upload at a time, with a 5 second pacing delay between uploads while more work is pending. It converts the plain queue work request into MeshCore.io's signed request format, sends it to the configured API URL, and classifies responses. With `MESHCOREIO_DRY_RUN=true`, the poster stops after conversion/signing and marks the work handled without making the HTTP request. Inserted, duplicate, and coordinates-missing responses are considered handled from this bridge's perspective. Connection failures and non-terminal HTTP/server errors are returned to the queue for retry.

## Logging

The advert pipeline logs exactly one line per actual meshcore.io exchange:

```text
Advert SE-STO-TEST (a09aa5) sent to meshcore.io: NODES_INSERTED
```

Known terminal responses get a short explanation (`ERR_ADVERT_DUPLICATE – node was updated recently`, `ERR_COORDS_MISSING – map coordinates are missing`); other responses log the response code or the raw body. In dry-run mode the line reads `Dry run: would send advert ...` instead.

Everything else in the pipeline is silent: dropped adverts (wrong type, bad signature, missing radio parameters, replays, cooldown, reupload interval), retry attempts, and queue registrations. Operational events are still logged: startup public keys, MQTT connect/offline problems, a full upload queue, and the single warning emitted when a job exhausts its retries. Because only the first valid copy of an advert is ever queued, several observers hearing the same advert produce at most one outcome line.

## Conversion Flow

1. Connect to the source MQTT broker and subscribe to `TOPIC_FILTER`.
2. For every MQTT message, inspect the topic to decide whether it is `status`, `raw`, or `packets`.
3. Store valid `status` radio parameters by observer public key.
4. Extract packet hex from `raw` or `packets` payloads and find the observer public key from `origin_id` or the topic.
5. Parse the packet with `Packet.fromBytes(...)`.
6. Continue only if the packet payload is a MeshCore `ADVERT`.
7. Parse the advert, verify its signature, and keep only `REPEATER`, `ROOM`, and `SENSOR` adverts.
8. Format eligible adverts as queue work requests with normalized observer radio parameters and the original packet bytes.
9. Put work requests through a bounded global posting queue.
10. Skip stale adverts, duplicate queued or in-flight nodes, too-frequent reuploads, and adverts without complete valid radio parameters.
11. Build MeshCore.io upload data with normalized radio params and a `meshcore://...` link containing the original packet bytes.
12. Sign the upload with the service's in-memory private key (ephemeral per start, or fixed via `MESHCOREIO_PRIVATE_KEY`).
13. POST the signed request to MeshCore.io and log the API result.
14. Treat terminal MeshCore.io API responses, such as inserted, duplicate, or coordinates-missing responses, as handled and remove them from the queue.
15. Retry failed upload attempts by reducing `retriesAllowed` and placing the advert at the back of the global queue until no retries remain.
16. Wait 5 seconds between uploads while more queued work remains.

Deduplication, replay protection, queued uploads, in-flight uploads, retry state, and observer radio state are all kept in memory only. A service restart starts with empty caches; observers repopulate their radio parameters with their next `status` publish, and MeshCore.io may still apply its own duplicate handling.

If the same advert is heard by multiple observers, the bridge uploads the first accepted copy for that advertised node/timestamp. Later copies with different observer radio data may be skipped by duplicate and reupload protection.
